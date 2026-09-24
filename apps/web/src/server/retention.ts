import type { PrismaClient } from '@kestrel/db';

export type RetentionDb = Pick<
  PrismaClient,
  'gatewayEvent' | 'incident' | 'alertDelivery' | 'remoteCommand' | 'deployment'
>;

export const RETENTION_DAYS = 90;

/** Deletes telemetry and history older than the retention window. Open incidents are never touched. */
export async function pruneOldData(db: RetentionDb, now = new Date(), days = RETENTION_DAYS) {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const [events, incidents, deliveries, commands] = await Promise.all([
    db.gatewayEvent.deleteMany({ where: { at: { lt: cutoff } } }),
    db.incident.deleteMany({ where: { status: 'resolved', resolvedAt: { lt: cutoff } } }),
    db.alertDelivery.deleteMany({ where: { at: { lt: cutoff } } }),
    db.remoteCommand.deleteMany({ where: { finishedAt: { lt: cutoff } } }),
  ]);
  return {
    events: events.count,
    incidents: incidents.count,
    deliveries: deliveries.count,
    commands: commands.count,
    cutoff,
  };
}
