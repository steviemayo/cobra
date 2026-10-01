import type { PrismaClient } from '@kestrel/db';

import { pruneLatency } from './latency';

export type RetentionDb = Pick<
  PrismaClient,
  | 'gatewayEvent'
  | 'incident'
  | 'alertDelivery'
  | 'remoteCommand'
  | 'deployment'
  | 'calendarFire'
  | 'controlIntent'
> &
  Partial<Pick<PrismaClient, 'latencyBucket' | 'latencyHour'>>;

export const RETENTION_DAYS = 90;

/** Deletes telemetry and history older than the retention window. Open incidents are never touched. */
export async function pruneOldData(db: RetentionDb, now = new Date(), days = RETENTION_DAYS) {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const [events, incidents, deliveries, commands, , , latency] = await Promise.all([
    db.gatewayEvent.deleteMany({ where: { at: { lt: cutoff } } }),
    db.incident.deleteMany({ where: { status: 'resolved', resolvedAt: { lt: cutoff } } }),
    db.alertDelivery.deleteMany({ where: { at: { lt: cutoff } } }),
    db.remoteCommand.deleteMany({ where: { finishedAt: { lt: cutoff } } }),
    // Bookkeeping for calendar meetings and portal requests, of no use once they are long past.
    db.calendarFire.deleteMany({ where: { firedAt: { lt: cutoff } } }),
    db.controlIntent.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    // Response times: the 5-minute buckets only live a week; the hourly rollup lives as long as the rest.
    pruneLatency(db, now, days),
  ]);
  return {
    events: events.count,
    incidents: incidents.count,
    deliveries: deliveries.count,
    commands: commands.count,
    latencyBuckets: latency.buckets,
    latencyHours: latency.hours,
    cutoff,
  };
}
