import type { PrismaClient } from '@kestrel/db';

// How long the activity log is kept. Everything is kept for the organisation's retention period
// (12 months unless staff extended it). Billing and access-change events are kept longer: seven
// years, or the organisation's period if that is longer. The staff trail (who at Kestrel looked at
// what) is kept seven years. Functions take the database as a parameter so they can be tested
// without one.
export type AuditRetentionDb = Pick<PrismaClient, 'auditLog' | 'staffAudit' | 'orgRetention'>;

export const DEFAULT_AUDIT_DAYS = 365;
/** Staff can extend an organisation's retention, never shorten it below the default. */
export const MIN_AUDIT_DAYS = DEFAULT_AUDIT_DAYS;
export const MAX_AUDIT_DAYS = 3650;
export const LONG_KEEP_DAYS = 2555;
export const STAFF_AUDIT_DAYS = 2555;

/** Events that record money or who can get in. Matched by the start of the action name. */
export const LONG_KEPT_PREFIXES = [
  'billing.',
  'license.',
  'member.',
  'invite.',
  'msp.',
  'session.',
  'staff.',
  'org.staff_access',
  'org.retention',
  'marketplace.checkout',
] as const;

export const isLongKept = (action: string) => LONG_KEPT_PREFIXES.some((p) => action.startsWith(p));

const DAY = 86_400_000;
const longKept = () => LONG_KEPT_PREFIXES.map((p) => ({ action: { startsWith: p } }));

export class RetentionError extends Error {}

export interface AuditRetention {
  /** How long ordinary events are kept. */
  days: number;
  /** Staff changed it from the default. */
  custom: boolean;
  /** How long billing and access-change events are kept. */
  longKeptDays: number;
}

export async function auditRetentionFor(
  db: AuditRetentionDb,
  orgId: string,
): Promise<AuditRetention> {
  const row = await db.orgRetention.findFirst({ where: { orgId } });
  const days = row?.auditDays ?? DEFAULT_AUDIT_DAYS;
  return {
    days,
    custom: days !== DEFAULT_AUDIT_DAYS,
    longKeptDays: Math.max(LONG_KEEP_DAYS, days),
  };
}

/** Change how long an organisation's activity log is kept. Between the default and ten years. */
export async function setAuditRetention(
  db: AuditRetentionDb,
  input: { orgId: string; days: number; staffUserId: string },
): Promise<AuditRetention> {
  const { orgId, days } = input;
  if (!Number.isInteger(days) || days < MIN_AUDIT_DAYS || days > MAX_AUDIT_DAYS)
    throw new RetentionError(
      `Keep the activity log between ${MIN_AUDIT_DAYS} days and ${MAX_AUDIT_DAYS} days`,
    );
  const existing = await db.orgRetention.findFirst({ where: { orgId } });
  if (existing)
    await db.orgRetention.update({
      where: { orgId },
      data: { auditDays: days, updatedBy: input.staffUserId },
    });
  else
    await db.orgRetention.create({
      data: { orgId, auditDays: days, updatedBy: input.staffUserId },
    });
  return auditRetentionFor(db, orgId);
}

export interface AuditPruneResult {
  /** Activity log rows deleted. */
  audit: number;
  /** Staff trail rows deleted. */
  staff: number;
}

/**
 * Deletes activity log rows past their retention: ordinary events after the organisation's period,
 * billing and access-change events after the longer one, and the staff trail after seven years.
 */
export async function pruneAudit(
  db: AuditRetentionDb,
  now = new Date(),
): Promise<AuditPruneResult> {
  const custom = await db.orgRetention.findMany({});
  const customIds = custom.map((c) => c.orgId);
  const before = (days: number) => ({ lt: new Date(now.getTime() - days * DAY) });
  let audit = 0;

  // Every organisation on the default, then each one staff changed.
  const groups: { org: object; days: number }[] = [
    { org: { orgId: { notIn: customIds } }, days: DEFAULT_AUDIT_DAYS },
    ...custom.map((c) => ({ org: { orgId: c.orgId }, days: c.auditDays })),
  ];
  for (const g of groups) {
    const ordinary = await db.auditLog.deleteMany({
      where: { ...g.org, createdAt: before(g.days), NOT: longKept() },
    });
    const kept = await db.auditLog.deleteMany({
      where: { ...g.org, createdAt: before(Math.max(LONG_KEEP_DAYS, g.days)), OR: longKept() },
    });
    audit += ordinary.count + kept.count;
  }
  const staff = await db.staffAudit.deleteMany({ where: { createdAt: before(STAFF_AUDIT_DAYS) } });
  return { audit, staff: staff.count };
}
