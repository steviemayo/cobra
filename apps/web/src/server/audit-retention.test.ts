import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUDIT_DAYS,
  LONG_KEEP_DAYS,
  RetentionError,
  STAFF_AUDIT_DAYS,
  auditRetentionFor,
  isLongKept,
  pruneAudit,
  setAuditRetention,
  type AuditRetentionDb,
} from './audit-retention';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '11111111-1111-4111-8111-111111111112';
const STAFF = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-09-26T00:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

function world(rows: { orgId?: string; action: string; days: number }[] = []) {
  const auditLog = table(
    rows.map((r, i) => ({
      id: `a${i}`,
      orgId: r.orgId ?? ORG,
      action: r.action,
      createdAt: ago(r.days),
    })),
  );
  const staffAudit = table([]);
  const orgRetention = table([]);
  return {
    db: { auditLog, staffAudit, orgRetention } as unknown as AuditRetentionDb,
    auditLog,
    staffAudit,
    orgRetention,
  };
}
const left = (w: ReturnType<typeof world>) => w.auditLog.rows.map((r) => r.id);

describe('what counts as long kept', () => {
  it('billing and access-change events are, everyday changes are not', () => {
    for (const a of [
      'billing.subscribe',
      'license.adjust',
      'member.role',
      'invite.create',
      'msp.invite',
      'session.start',
      'staff.session.start',
      'org.staff_access',
      'org.retention',
    ])
      expect(isLongKept(a), a).toBe(true);
    for (const a of [
      'room.update',
      'deployment.create',
      'control.intent',
      'org.rename',
      'ticket.create',
    ])
      expect(isLongKept(a), a).toBe(false);
  });
});

describe('pruning the activity log', () => {
  it('deletes everyday events after 12 months and keeps newer ones', async () => {
    const w = world([
      { action: 'room.update', days: 364 },
      { action: 'room.update', days: 366 },
      { action: 'deployment.create', days: 1000 },
    ]);
    const res = await pruneAudit(w.db, NOW);
    expect(left(w)).toEqual(['a0']);
    expect(res.audit).toBe(2);
  });

  it('keeps billing and access changes past 12 months, until seven years', async () => {
    const w = world([
      { action: 'billing.subscribe', days: 400 },
      { action: 'member.role', days: 2000 },
      { action: 'license.adjust', days: LONG_KEEP_DAYS - 1 },
      { action: 'billing.subscribe', days: LONG_KEEP_DAYS + 1 },
      { action: 'invite.create', days: LONG_KEEP_DAYS + 30 },
    ]);
    await pruneAudit(w.db, NOW);
    expect(left(w)).toEqual(['a0', 'a1', 'a2']);
  });

  it('follows a longer period staff set for one organisation, and only for that one', async () => {
    const w = world([
      { action: 'room.update', days: 500 },
      { orgId: OTHER, action: 'room.update', days: 500 },
      { action: 'room.update', days: 800 },
    ]);
    w.orgRetention.rows.push({ orgId: ORG, auditDays: 730 });
    await pruneAudit(w.db, NOW);
    // ORG keeps its 500-day row (window 730) but not the 800-day one; OTHER is on the default.
    expect(left(w)).toEqual(['a0']);
  });

  it('a period longer than seven years also stretches the long-kept events', async () => {
    const w = world([{ action: 'billing.subscribe', days: 3000 }]);
    w.orgRetention.rows.push({ orgId: ORG, auditDays: 3650 });
    await pruneAudit(w.db, NOW);
    expect(left(w)).toEqual(['a0']);
  });

  it('deletes the staff trail after seven years only', async () => {
    const w = world();
    w.staffAudit.rows.push(
      { id: 's1', createdAt: ago(STAFF_AUDIT_DAYS + 1) },
      { id: 's2', createdAt: ago(800) },
    );
    const res = await pruneAudit(w.db, NOW);
    expect(w.staffAudit.rows.map((r) => r.id)).toEqual(['s2']);
    expect(res.staff).toBe(1);
  });

  it('does nothing when there is nothing old', async () => {
    const w = world([{ action: 'room.update', days: 5 }]);
    expect(await pruneAudit(w.db, NOW)).toEqual({ audit: 0, staff: 0 });
  });
});

describe('the retention setting', () => {
  it('is 12 months until staff change it', async () => {
    const w = world();
    expect(await auditRetentionFor(w.db, ORG)).toEqual({
      days: DEFAULT_AUDIT_DAYS,
      custom: false,
      longKeptDays: LONG_KEEP_DAYS,
    });
  });

  it('staff can extend it, and again, but never below the default or past ten years', async () => {
    const w = world();
    const set = (days: number) => setAuditRetention(w.db, { orgId: ORG, days, staffUserId: STAFF });
    expect(await set(730)).toMatchObject({ days: 730, custom: true });
    expect(w.orgRetention.rows).toHaveLength(1);
    expect(await set(1095)).toMatchObject({ days: 1095 });
    expect(w.orgRetention.rows).toHaveLength(1);
    expect(w.orgRetention.rows[0]).toMatchObject({ updatedBy: STAFF });
    await expect(set(364)).rejects.toBeInstanceOf(RetentionError);
    await expect(set(3651)).rejects.toBeInstanceOf(RetentionError);
    await expect(set(400.5)).rejects.toBeInstanceOf(RetentionError);
    expect((await auditRetentionFor(w.db, ORG)).days).toBe(1095);
  });

  it('a long period lengthens the long-kept window too', async () => {
    const w = world();
    await setAuditRetention(w.db, { orgId: ORG, days: 3650, staffUserId: STAFF });
    expect((await auditRetentionFor(w.db, ORG)).longKeptDays).toBe(3650);
  });
});
