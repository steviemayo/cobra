import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '@kestrel/db';
import { alertChannelAllowed } from '@kestrel/model';
import { ChannelRules, dueNow, hasRules } from './alert-rules';
import { getEntitlements, type EntitlementDb } from './billing';
import { SEVERITY_RANK, type AlertJob, type Severity } from './monitoring';
import { pinnedFetch, postJson, resolveAll, type Lookup } from './outbound';

export type AlertDb = Pick<PrismaClient, 'alertChannel' | 'alertDelivery' | 'incident' | 'room'>;

export const CHANNEL_TYPES = ['email', 'teams', 'webhook', 'itsm'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

// Every channel may carry timing rules (see alert-rules.ts); without them it alerts at once, always.
const rules = { rules: ChannelRules.optional() };

export const ChannelConfig = z.discriminatedUnion('type', [
  z.object({ type: z.literal('email'), to: z.array(z.string().email()).min(1).max(10), ...rules }),
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
  event: 'opened' | 'reminder' | 'resolved' | 'test';
  incident: {
    id: string;
    kind: string;
    severity: Severity;
    title: string;
    detail: string | null;
    room: string | null;
    openedAt: string;
    resolvedAt: string | null;
  };
  portalUrl: string | null;
}

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
const realSenders = (): Senders => ({
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

const post = (s: Senders, rawUrl: string, body: string, headers: Record<string, string> = {}) =>
  postJson(s, rawUrl, body, headers);

function payload(m: AlertMessage) {
  return { event: m.event, incident: m.incident, portalUrl: m.portalUrl };
}

export async function send(s: Senders, config: ChannelConfig, m: AlertMessage): Promise<void> {
  switch (config.type) {
    case 'webhook': {
      const body = JSON.stringify(payload(m));
      const headers: Record<string, string> = {};
      if (config.secret) {
        const ts = String(Math.floor(Date.now() / 1000));
        headers['x-kestrel-timestamp'] = ts;
        headers['x-kestrel-signature'] =
          `sha256=${createHmac('sha256', config.secret).update(`${ts}.${body}`).digest('hex')}`;
      }
      return post(s, config.url, body, headers);
    }
    case 'itsm': {
      if (!config.url) throw new NotConfigured('No service desk address is set yet');
      const body = JSON.stringify({
        system: config.system,
        ...payload(m),
        ticket: {
          short_description: headline(m),
          description: m.incident.detail ?? '',
          urgency:
            m.incident.severity === 'critical' ? 1 : m.incident.severity === 'warning' ? 2 : 3,
          state: m.event === 'resolved' ? 'resolved' : 'new',
          correlation_id: m.incident.id,
        },
      });
      return post(s, config.url, body);
    }
    case 'teams': {
      const body = JSON.stringify({
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              type: 'AdaptiveCard',
              version: '1.4',
              body: [
                {
                  type: 'TextBlock',
                  weight: 'Bolder',
                  size: 'Medium',
                  wrap: true,
                  text: headline(m),
                },
                ...(m.incident.room
                  ? [
                      {
                        type: 'TextBlock',
                        wrap: true,
                        isSubtle: true,
                        text: `Room: ${m.incident.room}`,
                      },
                    ]
                  : []),
                ...(m.incident.detail
                  ? [{ type: 'TextBlock', wrap: true, text: m.incident.detail }]
                  : []),
              ],
              actions: m.portalUrl
                ? [{ type: 'Action.OpenUrl', title: 'Open in Kestrel', url: m.portalUrl }]
                : [],
            },
          },
        ],
      });
      return post(s, config.url, body);
    }
    case 'email': {
      const key = s.env.RESEND_API_KEY;
      const from = s.env.ALERT_FROM_EMAIL;
      if (!key || !from) throw new NotConfigured('Email is not set up on this Kestrel server');
      const text = [
        headline(m),
        m.incident.room ? `Room: ${m.incident.room}` : '',
        m.incident.detail ?? '',
        m.portalUrl ?? '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const res = await s.fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: config.to, subject: `[Kestrel] ${headline(m)}`, text }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`The email service answered HTTP ${res.status}`);
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
const HOUR_MS = 3_600_000;
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

type IncidentRow = NonNullable<Awaited<ReturnType<AlertDb['incident']['findFirst']>>>;

async function buildMessage(
  db: AlertDb,
  incident: IncidentRow,
  event: AlertMessage['event'],
  env: Record<string, string | undefined>,
  roomNames = new Map<string, string | null>(),
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
  return {
    event,
    incident: {
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

const reaches = (incident: { severity: string }, ch: { minSeverity: string }) =>
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
      const msg = await buildMessage(db, incident, job.event, s.env);
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
              status: 'sent',
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
        const failed = history.filter((d) => d.status !== 'sent');
        const lastTry = failed.length ? Math.max(...failed.map((d) => d.at.getTime())) : 0;
        if (failed.length >= MAX_ATTEMPTS || now.getTime() < lastTry + RETRY_AFTER_MS) continue;
        const due = dueNow({
          rules,
          openedAt: incident.openedAt,
          acknowledged: incident.acknowledgedAt !== null,
          sent: history
            .filter((d) => d.status === 'sent')
            .map((d) => ({ event: d.event, at: d.at })),
          now,
        });
        if (!due) continue;
        const msg = await buildMessage(db, incident, due, s.env, roomNames);
        if ((await deliverToChannel(db, ch, msg, incident.id, s, now)).status === 'sent') sent++;
      } catch (e) {
        console.error('[alerts] due delivery failed', e);
      }
    }
  }
  return sent;
}
