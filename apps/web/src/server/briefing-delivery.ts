import type { PrismaClient } from '@kestrel/db';
import {
  deliverToChannel,
  portalLink,
  realSenders,
  type AlertDb,
  type AlertMessage,
  type Senders,
} from './alerts';
import { getEntitlements, type EntitlementDb } from './billing';
import {
  briefingSeverity,
  buildBriefing,
  formatBriefing,
  type Briefing,
  type BriefingDb,
} from './briefing';

// Sending the daily briefing to the people who signed up for it. The cron calls `runBriefings`
// once a day; "send me one now" calls `sendBriefing` for a single sign-up.

/** A briefing is sent at most once in this long, so a retried or doubled cron never repeats it. */
export const BRIEFING_MIN_GAP_MS = 20 * 3_600_000;
/** Channel types a briefing makes sense on (a service desk would open a ticket from it). */
export const BRIEFING_CHANNEL_TYPES = ['email', 'sms', 'teams', 'webhook'] as const;
export const briefingChannelOk = (type: string) =>
  (BRIEFING_CHANNEL_TYPES as readonly string[]).includes(type);

export type BriefingDeliveryDb = AlertDb &
  BriefingDb &
  Pick<PrismaClient, 'briefingSubscription' | 'org' | 'site'>;

export function briefingMessage(
  b: Briefing,
  orgId: string,
  now: Date,
  env: Record<string, string | undefined> = process.env,
): AlertMessage {
  const { title, body } = formatBriefing(b);
  return {
    event: 'summary',
    incident: {
      id: `briefing:${orgId}`,
      kind: 'briefing',
      severity: briefingSeverity(b),
      title,
      detail: body,
      room: null,
      openedAt: now.toISOString(),
      resolvedAt: null,
    },
    portalUrl: portalLink(orgId, '/incidents', env),
  };
}

type Sub = {
  id: string;
  orgId: string;
  siteId: string | null;
  channel: { id: string; orgId: string; type: string; config: unknown; enabled: boolean };
};

/** Builds (or reuses) the briefing for the sign-up's scope and sends it to its channel. */
export async function sendBriefing(
  db: BriefingDeliveryDb,
  sub: Sub,
  now: Date,
  cache = new Map<string, Briefing>(),
  s: Senders = realSenders(),
) {
  if (!sub.channel.enabled || !briefingChannelOk(sub.channel.type))
    return { status: 'skipped' as const, error: 'This channel cannot carry a briefing' };
  const key = `${sub.orgId}:${sub.siteId ?? ''}`;
  let briefing = cache.get(key);
  if (!briefing) {
    const [org, site] = await Promise.all([
      db.org.findFirst({ where: { id: sub.orgId }, select: { name: true } }),
      sub.siteId
        ? db.site.findFirst({ where: { id: sub.siteId, orgId: sub.orgId }, select: { name: true } })
        : null,
    ]);
    briefing = await buildBriefing(db, {
      orgId: sub.orgId,
      siteId: sub.siteId,
      scopeName: site?.name ?? org?.name ?? 'your organisation',
      now,
    });
    cache.set(key, briefing);
  }
  const result = await deliverToChannel(
    db,
    sub.channel,
    briefingMessage(briefing, sub.orgId, now, s.env),
    null,
    s,
    now,
  );
  await db.briefingSubscription.update({ where: { id: sub.id }, data: { lastSentAt: now } });
  return result;
}

/** Sends every due briefing. One failing sign-up never stops the others. */
export async function runBriefings(
  db: BriefingDeliveryDb,
  now = new Date(),
  s: Senders = realSenders(),
) {
  const subs = await db.briefingSubscription.findMany({
    where: {
      enabled: true,
      OR: [
        { lastSentAt: null },
        { lastSentAt: { lt: new Date(now.getTime() - BRIEFING_MIN_GAP_MS) } },
      ],
      org: { deletedAt: null },
    },
    include: { channel: true },
    take: 2000,
  });
  const cache = new Map<string, Briefing>();
  const monitored = new Map<string, boolean>();
  const out = { sent: 0, failed: 0, skipped: 0 };
  for (const sub of subs) {
    try {
      if (!monitored.has(sub.orgId))
        monitored.set(
          sub.orgId,
          Boolean((await getEntitlements(db as unknown as EntitlementDb, sub.orgId)).monitoring),
        );
      // A briefing is a monitoring feature: a lapsed plan stops it.
      if (!monitored.get(sub.orgId)) {
        out.skipped++;
        continue;
      }
      const r = await sendBriefing(db, sub, now, cache, s);
      if (r.status === 'sent') out.sent++;
      else if (r.status === 'failed') out.failed++;
      else out.skipped++;
    } catch (e) {
      console.error('[briefing] could not send', sub.id, e);
      out.failed++;
    }
  }
  return out;
}
