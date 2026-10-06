import { z } from 'zod';
import type { PrismaClient } from '@kestrel/db';
import { alertChannelAllowed } from '@kestrel/model';
import { incidentMuted } from './alert-mute';
import { ChannelRules, dueNow, hasRules } from './alert-rules';
import { getEntitlements, type EntitlementDb } from './billing';
import { SEVERITY_RANK, type AlertJob, type Severity } from './monitoring';
import { pinnedFetch, postJson, postSigned, resolveAll, type Lookup } from './outbound';
import { sendEmail } from './resend';
import { sendSms } from './sms';
import { affectedForRooms, type Impact } from './room-schedule';

// `site` and `roomSchedule` are only needed to say which meetings a fault may affect.
export type AlertDb = Pick<PrismaClient, 'alertChannel' | 'alertDelivery' | 'incident' | 'room'> &
  Partial<Pick<PrismaClient, 'site' | 'roomSchedule' | 'org' | 'gateway'>>;

export const CHANNEL_TYPES = ['email', 'sms', 'teams', 'webhook', 'itsm'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

// Every channel may carry timing rules (see alert-rules.ts); without them it alerts at once, always.
const rules = { rules: ChannelRules.optional() };

export const ChannelConfig = z.discriminatedUnion('type', [
  z.object({ type: z.literal('email'), to: z.array(z.string().email()).min(1).max(10), ...rules }),
  // Mobile numbers in international format, e.g. +61412345678.
  z.object({
    type: z.literal('sms'),
    to: z.array(z.string().regex(/^\+[1-9]\d{7,14}$/)).min(1).max(5),
    ...rules,
  }),
  z.object({ type: z.literal('teams'), url: z.string().url().max(2000), ...rules }),
  z.object({
    type: z.literal('webhook'),
    url: z.string().url().max(2000),
    secret: z.string().min(8).max(200).optional(),
    ...rules,
  }),
  // A placeholder for a service desk: sends the same payload as a webhook, tagged for ITSM tools.
  z.object({
    type: z.literal('itsm'),
    system: z.enum(['generic', 'servicenow', 'jira']).default('generic'),
    url: z.string().url().max(2000).optional(),
    ...rules,
  }),
]);
export type ChannelConfig = z.infer<typeof ChannelConfig>;

export interface AlertMessage {
  event: 'opened' | 'reminder' | 'resolved' | 'test' | 'summary';
  incident: {
    id: string;
    kind: string;
    severity: Severity;
    title: string;
    detail: string | null;
    room: string | null;
    openedAt: string;
    resolvedAt: string | null;
    /**
     * Meetings in the room's calendar that this may disturb (on now or starting in the next 12
     * hours). Private meetings have no title or organiser. Absent when the room has no calendar.
     */
    impact?: Impact;
  };
  portalUrl: string | null;
  /** The organisation's name, for channels that show it. Filled in at delivery. */
  org?: string;
  /**
   * Present when this one message stands for several incidents that belong together (a room's
   * problems, a site's). `incident` is then the headline of the group, and these are its members.
   */
  batch?: {
    count: number;
    incidents: { id: string; kind: string; severity: Severity; title: string; room: string | null }[];
  };
}

const impactText = (m: AlertMessage): string =>
  m.incident.impact?.lines.length
    ? [
        'This may affect:',
        ...m.incident.impact.lines.map((l) => `- ${l}`),
        ...(m.incident.impact.more ? [`- and ${m.incident.impact.more} more`] : []),
      ].join('\n')
    : '';

/** The destination isn't set up, so nothing was tried. Recorded as skipped, not failed. */
export class NotConfigured extends Error {}

// ---- Senders -----------------------------------------------------------------------------------

export type Sender = (config: ChannelConfig, msg: AlertMessage) => Promise<void>;
export interface Senders {
  fetch: typeof fetch;
  resolve: Lookup;
  env: Record<string, string | undefined>;
  /** Whether the organisation's plan lets this kind of channel send. Absent means anything goes. */
  allowed?: (db: AlertDb, orgId: string, type: string) => Promise<boolean>;
}
export const realSenders = (): Senders => ({
  fetch: pinnedFetch,
  resolve: resolveAll,
  env: process.env,
  // The real client carries the billing tables; AlertDb only names the ones alerts need.
  allowed: async (db, orgId, type) =>
    alertChannelAllowed(await getEntitlements(db as unknown as EntitlementDb, orgId), type),
});

export const CHANNEL_NOT_IN_PLAN = 'Your plan does not include this kind of alert channel';

const headline = (m: AlertMessage) =>
  m.event === 'resolved'
    ? `Resolved: ${m.incident.title}`
    : m.event === 'reminder'
      ? `Reminder, still open: ${m.incident.title}`
      : m.event === 'test'
        ? `Test alert: ${m.incident.title}`
        : m.incident.title;

type Tone = { style: string; color: string; label: string };

/** How the card is coloured and labelled: by what happened first, then by how bad the incident is. */
function toneOf(m: AlertMessage): Tone {
  switch (m.event) {
    case 'resolved':
      return { style: 'good', color: 'Good', label: 'RESOLVED' };
    case 'test':
      return { style: 'emphasis', color: 'Default', label: 'TEST' };
    case 'summary':
      return m.incident.severity === 'critical' || m.incident.severity === 'warning'
        ? severityTone(m.incident.severity, 'SUMMARY')
        : { style: 'accent', color: 'Accent', label: 'SUMMARY' };
    default:
      return severityTone(m.incident.severity, m.event === 'reminder' ? 'STILL OPEN' : undefined);
  }
}

function severityTone(severity: Severity, label?: string): Tone {
  if (severity === 'critical')
    return { style: 'attention', color: 'Attention', label: label ?? 'CRITICAL' };
  if (severity === 'warning')
    return { style: 'warning', color: 'Warning', label: label ?? 'WARNING' };
  return { style: 'accent', color: 'Accent', label: label ?? 'INFO' };
}

const durationText = (from: string, to: string): string => {
  const mins = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return mins % 60 ? `${h} h ${mins % 60} min` : `${h} h`;
};

/** Adaptive Card for Teams: a coloured header band, the title, a fact table, then the detail. */
export function teamsCard(m: AlertMessage) {
  const tone = toneOf(m);
  const i = m.incident;
  // Teams turns these into the reader's own date and time format and time zone.
  const when = (iso: string) => `{{DATE(${iso},SHORT)}} {{TIME(${iso})}}`;
  const facts: { title: string; value: string }[] = [
    ...(i.room ? [{ title: 'Room', value: i.room }] : []),
    ...(m.event === 'opened' || m.event === 'reminder' || m.event === 'resolved'
      ? [{ title: 'Opened', value: when(i.openedAt) }]
      : []),
    ...(i.resolvedAt
      ? [
          { title: 'Resolved', value: when(i.resolvedAt) },
          { title: 'Duration', value: durationText(i.openedAt, i.resolvedAt) },
        ]
      : []),
    ...(m.event !== 'resolved' && m.event !== 'test' && m.event !== 'summary'
      ? [{ title: 'Severity', value: i.severity[0]!.toUpperCase() + i.severity.slice(1) }]
      : []),
  ];
  const impact = impactText(m);
  const batch = m.batch?.incidents ?? [];
  const body = [
    {
      type: 'Container',
      style: tone.style,
      bleed: true,
      items: [
        {
          type: 'ColumnSet',
          columns: [
            {
              type: 'Column',
              width: 'stretch',
              items: [
                {
                  type: 'TextBlock',
                  text: tone.label,
                  weight: 'Bolder',
                  size: 'Small',
                  color: tone.color,
                  spacing: 'None',
                },
              ],
            },
            {
              type: 'Column',
              width: 'auto',
              items: [
                {
                  type: 'TextBlock',
                  text: m.org ?? 'Kestrel',
                  size: 'Small',
                  isSubtle: true,
                  horizontalAlignment: 'Right',
                  spacing: 'None',
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'TextBlock',
      text: i.title,
      weight: 'Bolder',
      size: 'Large',
      wrap: true,
      spacing: 'Medium',
    },
    ...(facts.length ? [{ type: 'FactSet', facts, spacing: 'Medium' }] : []),
    ...(i.detail
      ? [
          {
            type: 'Container',
            separator: true,
            spacing: 'Medium',
            items: [{ type: 'TextBlock', text: i.detail.replaceAll('\n', '\n\n'), wrap: true }],
          },
        ]
      : []),
    ...(batch.length > 1 && !i.detail
      ? [
          {
            type: 'Container',
            separator: true,
            spacing: 'Medium',
            items: batch.map((b) => ({ type: 'TextBlock', text: `- ${b.title}`, wrap: true })),
          },
        ]
      : []),
    ...(impact
      ? [
          {
            type: 'Container',
            style: 'emphasis',
            spacing: 'Medium',
            items: [
              { type: 'TextBlock', text: impact.replaceAll('\n', '\n\n'), wrap: true, size: 'Small' },
            ],
          },
        ]
      : []),
  ];
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.5',
          // Teams shows this in notifications and the chat list instead of the card.
          fallbackText: headline(m),
          msteams: { width: 'Full' },
          body,
          actions: m.portalUrl
            ? [{ type: 'Action.OpenUrl', title: 'Open in Kestrel', url: m.portalUrl, style: 'positive' }]
            : [],
        },
      },
    ],
  };
}

export function payload(m: AlertMessage) {
  return {
    event: m.event,
    incident: m.incident,
    portalUrl: m.portalUrl,
    ...(m.batch ? { batch: m.batch } : {}),
  };
}

export async function send(s: Senders, config: ChannelConfig, m: AlertMessage): Promise<void> {
  switch (config.type) {
    case 'webhook':
      return postSigned(s, config.url, payload(m), config.secret);
    case 'itsm': {
      if (!config.url) throw new NotConfigured('No service desk address is set yet');
      const body = JSON.stringify({
        system: config.system,
        ...payload(m),
        ticket: {
          short_description: headline(m),
          description: [m.incident.detail ?? '', impactText(m)].filter(Boolean).join('\n\n'),
          urgency:
            m.incident.severity === 'critical' ? 1 : m.incident.severity === 'warning' ? 2 : 3,
          state: m.event === 'resolved' ? 'resolved' : 'new',
          correlation_id: m.incident.id,
        },
      });
      return postJson(s, config.url, body);
    }
    case 'teams':
      return postJson(s, config.url, JSON.stringify(teamsCard(m)));
    case 'sms': {
      const text = [headline(m), m.incident.room ? `Room: ${m.incident.room}` : '', m.portalUrl ?? '']
        .filter(Boolean)
        .join('\n')
        .slice(0, 480);
      if (!(await sendSms(s, config.to, text)))
        throw new NotConfigured('Text messages are not set up on this Kestrel server');
      return;
    }
    case 'email': {
      const text = [
        headline(m),
        m.incident.room ? `Room: ${m.incident.room}` : '',
        m.incident.detail ?? '',
        impactText(m),
        m.portalUrl ?? '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const sent = await sendEmail(s, config.to, `[Kestrel] ${headline(m)}`, text);
      if (!sent) throw new NotConfigured('Email is not set up on this Kestrel server');
    }
  }
}

// ---- Delivery ----------------------------------------------------------------------------------

/** No channel is sent more than this many alerts an hour; the rest are recorded as suppressed. */
export const MAX_ALERTS_PER_CHANNEL_HOUR = 30;
/**
 * Email can reach anyone, not just the destination an org itself controls (a webhook or Teams URL
 * always belongs to whoever set it up); this bounds how much of Kestrel's own sending reputation
 * one organisation can spend in a day, across every email channel it has, so making several
 * channels does not multiply the hourly cap above.
 */
export const MAX_EMAIL_ALERTS_PER_ORG_PER_DAY = 200;
/** Text messages cost money per send, so an organisation's daily total is capped across its SMS channels. */
export const MAX_SMS_ALERTS_PER_ORG_PER_DAY = 100;
const HOUR_MS = 3_600_000;
const CAP_NOTICE_NOTE = 'Too many alerts in the last hour (a notice was sent)';

/** The one message that tells a channel it has hit its hourly limit. */
const capNotice = (m: AlertMessage): AlertMessage => ({
  event: 'summary',
  incident: {
    id: m.incident.id,
    kind: 'rollup',
    severity: m.incident.severity,
    title: 'Alert limit reached: further alerts for the next hour are only in the portal',
    detail: `This channel has had ${MAX_ALERTS_PER_CHANNEL_HOUR} alerts in the last hour. Kestrel keeps recording every incident; open the portal to see them all.`,
    room: null,
    openedAt: m.incident.openedAt,
    resolvedAt: null,
  },
  portalUrl: m.portalUrl,
});
const DAY_MS = 24 * HOUR_MS;

function parseChannel(row: { type: string; config: unknown }): ChannelConfig | null {
  const parsed = ChannelConfig.safeParse({ ...(row.config as object), type: row.type });
  return parsed.success ? parsed.data : null;
}

/** Sends one message to one channel and records what happened. Never throws. */
export async function deliverToChannel(
  db: AlertDb,
  channel: { id: string; orgId: string; type: string; config: unknown },
  msg: AlertMessage,
  incidentId: string | null,
  s: Senders = realSenders(),
  now = new Date(),
): Promise<{ status: 'sent' | 'failed' | 'suppressed' | 'skipped'; error?: string }> {
  const record = (status: string, error?: string) =>
    db.alertDelivery.create({
      data: {
        orgId: channel.orgId,
        channelId: channel.id,
        incidentId,
        event: msg.event,
        status,
        error: error ?? null,
        at: now,
      },
    });
  if (msg.event !== 'test') {
    const recent = await db.alertDelivery.count({
      where: {
        channelId: channel.id,
        status: 'sent',
        at: { gte: new Date(now.getTime() - HOUR_MS) },
      },
    });
    if (recent >= MAX_ALERTS_PER_CHANNEL_HOUR) {
      // Say once, per hour, that the rest are only in the portal, so a storm is never silent.
      const told = await db.alertDelivery.count({
        where: {
          channelId: channel.id,
          status: 'suppressed',
          error: CAP_NOTICE_NOTE,
          at: { gte: new Date(now.getTime() - HOUR_MS) },
        },
      });
      if (told === 0) {
        const config = parseChannel(channel);
        if (config) {
          try {
            await send(s, config, capNotice(msg));
            await record('suppressed', CAP_NOTICE_NOTE);
            return { status: 'suppressed' };
          } catch {
            // Fall through: recorded below like any other suppressed alert.
          }
        }
      }
      await record('suppressed', 'Too many alerts in the last hour');
      return { status: 'suppressed' };
    }
  }
  // Unlike the per-channel hourly cap, this applies to a test send too: email can reach anyone,
  // so it is the one channel type where "let me test it right away" must not mean "unlimited".
  if (channel.type === 'email') {
    const emailChannels = await db.alertChannel.findMany({
      where: { orgId: channel.orgId, type: 'email' },
      select: { id: true },
    });
    const sentToday = await db.alertDelivery.count({
      where: {
        channelId: { in: emailChannels.map((c) => c.id) },
        status: 'sent',
        at: { gte: new Date(now.getTime() - DAY_MS) },
      },
    });
    if (sentToday >= MAX_EMAIL_ALERTS_PER_ORG_PER_DAY) {
      await record('suppressed', 'Too many alert emails from this organisation today');
      return { status: 'suppressed' };
    }
  }
  if (channel.type === 'sms') {
    const smsChannels = await db.alertChannel.findMany({
      where: { orgId: channel.orgId, type: 'sms' },
      select: { id: true },
    });
    const sentToday = await db.alertDelivery.count({
      where: {
        channelId: { in: smsChannels.map((c) => c.id) },
        status: 'sent',
        at: { gte: new Date(now.getTime() - DAY_MS) },
      },
    });
    if (sentToday >= MAX_SMS_ALERTS_PER_ORG_PER_DAY) {
      await record('suppressed', 'Too many text message alerts from this organisation today');
      return { status: 'suppressed' };
    }
  }
  if (s.allowed && !(await s.allowed(db, channel.orgId, channel.type))) {
    await record('skipped', CHANNEL_NOT_IN_PLAN);
    return { status: 'skipped', error: CHANNEL_NOT_IN_PLAN };
  }
  const config = parseChannel(channel);
  if (!config) {
    await record('failed', 'This channel’s settings are invalid');
    return { status: 'failed', error: 'This channel’s settings are invalid' };
  }
  try {
    if (config.type === 'teams' && !msg.org && db.org) {
      const org = await db.org.findFirst({ where: { id: channel.orgId }, select: { name: true } });
      if (org?.name) msg = { ...msg, org: org.name };
    }
    await send(s, config, msg);
    await record('sent');
    return { status: 'sent' };
  } catch (e) {
    const error = e instanceof Error ? e.message.slice(0, 300) : 'Unknown error';
    const status = e instanceof NotConfigured ? 'skipped' : 'failed';
    await record(status, error);
    return { status, error };
  }
}

export function portalLink(
  orgId: string,
  path: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const base =
    env.NEXT_PUBLIC_APP_URL ??
    (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : null);
  return base ? `${base}/o/${orgId}${path}` : null;
}

/** A channel's timing rules, if it has any. */
export function channelRules(ch: { config: unknown }): ChannelRules | null {
  const parsed = ChannelRules.optional().safeParse(
    (ch.config as { rules?: unknown } | null)?.rules,
  );
  return parsed.success && hasRules(parsed.data) ? parsed.data : null;
}

export type IncidentRow = NonNullable<Awaited<ReturnType<AlertDb['incident']['findFirst']>>>;

export async function buildMessage(
  db: AlertDb,
  incident: IncidentRow,
  event: AlertMessage['event'],
  env: Record<string, string | undefined>,
  roomNames = new Map<string, string | null>(),
  now = new Date(),
): Promise<AlertMessage> {
  let room: string | null = null;
  if (incident.roomId) {
    if (!roomNames.has(incident.roomId))
      roomNames.set(
        incident.roomId,
        (await db.room.findFirst({ where: { id: incident.roomId } }))?.name ?? null,
      );
    room = roomNames.get(incident.roomId) ?? null;
  }
  let impact: Impact | undefined;
  if (incident.roomId && (event === 'opened' || event === 'reminder')) {
    try {
      impact = (await affectedForRooms(db, incident.orgId, [incident.roomId], now)).get(
        incident.roomId,
      );
    } catch (e) {
      // The calendar is only extra context: the alert goes out without it.
      console.error('[alerts] could not look up affected meetings', e);
    }
  }
  return {
    event,
    incident: {
      ...(impact ? { impact } : {}),
      id: incident.id,
      kind: incident.kind,
      severity: incident.severity as Severity,
      title: incident.title,
      detail: incident.detail,
      room,
      openedAt: incident.openedAt.toISOString(),
      resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    },
    portalUrl: portalLink(incident.orgId, `/incidents`, env),
  };
}

export const reaches = (incident: { severity: string }, ch: { minSeverity: string }) =>
  SEVERITY_RANK[incident.severity as Severity] >= SEVERITY_RANK[ch.minSeverity as Severity];

/** Sends the alerts a monitoring pass produced. Run it after the response, never inside it. */
export async function deliverAlerts(
  db: AlertDb,
  jobs: AlertJob[],
  s: Senders = realSenders(),
  now = new Date(),
): Promise<void> {
  for (const job of jobs) {
    try {
      const incident = await db.incident.findFirst({ where: { id: job.incidentId } });
      if (!incident) continue;
      // A muted room, site or organisation still has its incident; only the notification is held back.
      if (await incidentMuted(db, incident, now)) continue;
      const msg = await buildMessage(db, incident, job.event, s.env, undefined, now);
      const channels = await db.alertChannel.findMany({
        where: { orgId: incident.orgId, enabled: true },
      });
      for (const ch of channels) {
        if (!reaches(incident, ch)) continue;
        const rules = channelRules(ch);
        if (rules && job.event === 'opened') {
          // A channel with timing rules may hold the alert back; the sweep sends it when it is due.
          const due = dueNow({
            rules,
            openedAt: incident.openedAt,
            acknowledged: incident.acknowledgedAt !== null,
            sent: [],
            now,
          });
          if (due !== 'opened') continue;
        }
        if (rules && job.event === 'resolved') {
          // Only say it is fixed to a channel that was told about it.
          const told = await db.alertDelivery.count({
            where: {
              channelId: ch.id,
              incidentId: incident.id,
              status: { in: ['sent', 'batched'] },
              event: { in: ['opened', 'reminder'] },
            },
          });
          if (told === 0) continue;
        }
        await deliverToChannel(db, ch, msg, incident.id, s, now);
      }
    } catch (e) {
      console.error('[alerts] delivery failed', e);
    }
  }
}

/** A failed send is tried again after this long, and given up on after this many attempts. */
export const RETRY_AFTER_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 5;

/**
 * Sends what channels with timing rules are now due to send about incidents still open: alerts that
 * were held for their hours or their delay, and reminders. Meant to run every minute or two.
 */
export async function deliverDue(
  db: AlertDb,
  s: Senders = realSenders(),
  now = new Date(),
): Promise<number> {
  const withRules = (await db.alertChannel.findMany({ where: { enabled: true } })).flatMap((ch) => {
    const rules = channelRules(ch);
    return rules ? [{ ch, rules }] : [];
  });
  if (withRules.length === 0) return 0;
  const incidents = await db.incident.findMany({
    where: { orgId: { in: [...new Set(withRules.map((c) => c.ch.orgId))] }, status: 'open' },
  });
  const roomNames = new Map<string, string | null>();
  let sent = 0;
  for (const incident of incidents) {
    if (await incidentMuted(db, incident, now)) continue;
    for (const { ch, rules } of withRules) {
      if (ch.orgId !== incident.orgId || !reaches(incident, ch)) continue;
      try {
        const history = await db.alertDelivery.findMany({
          where: {
            channelId: ch.id,
            incidentId: incident.id,
            event: { in: ['opened', 'reminder'] },
          },
        });
        const failed = history.filter((d) => d.status !== 'sent' && d.status !== 'batched');
        const lastTry = failed.length ? Math.max(...failed.map((d) => d.at.getTime())) : 0;
        if (failed.length >= MAX_ATTEMPTS || now.getTime() < lastTry + RETRY_AFTER_MS) continue;
        const due = dueNow({
          rules,
          openedAt: incident.openedAt,
          acknowledged: incident.acknowledgedAt !== null,
          sent: history
            .filter((d) => d.status === 'sent' || d.status === 'batched')
            .map((d) => ({ event: d.event, at: d.at })),
          now,
        });
        if (!due) continue;
        const msg = await buildMessage(db, incident, due, s.env, roomNames, now);
        if ((await deliverToChannel(db, ch, msg, incident.id, s, now)).status === 'sent') sent++;
      } catch (e) {
        console.error('[alerts] due delivery failed', e);
      }
    }
  }
  return sent;
}
