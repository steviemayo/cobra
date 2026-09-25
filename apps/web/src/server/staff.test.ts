import { describe, expect, it } from 'vitest';
import { hasStaffRole } from '@kestrel/model';
import {
  findStaff,
  mfaRequired,
  orgDetail,
  orgDirectory,
  recordStaffAudit,
  type StaffDb,
} from './staff';
import { table } from './test-db';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '11111111-1111-4111-8111-111111111112';
const ORG_C = '11111111-1111-4111-8111-111111111113';
const USER = '44444444-4444-4444-8444-444444444441';
const STAFF = '55555555-5555-4555-8555-555555555551';
const NOW = new Date('2026-09-25T00:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const daysFromNow = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

function world() {
  const staffUser = table([
    { id: 's1', userId: STAFF, email: 'steve@kestrel.test', roles: ['admin'] },
  ]);
  const staffAudit = table([]);
  const org = table([
    { id: ORG_A, name: 'Acme', createdAt: new Date('2026-01-01') },
    { id: ORG_B, name: 'Beta', createdAt: new Date('2026-02-01') },
    { id: ORG_C, name: 'Gamma (no billing)', createdAt: new Date('2026-03-01') },
  ]);
  const orgBilling = table([
    { orgId: ORG_A, plan: 'trial', status: 'none', trialEndsAt: daysFromNow(5) },
    { orgId: ORG_B, plan: 'pro', status: 'active', trialEndsAt: daysFromNow(-40) },
  ]);
  const member = table([
    { orgId: ORG_A, userId: USER, email: 'owner@acme.test', role: 'owner' },
    { orgId: ORG_A, userId: 'u2', email: 'dev@acme.test', role: 'dev' },
    { orgId: ORG_B, userId: 'u3', email: 'owner@beta.test', role: 'owner' },
  ]);
  const site = table([{ id: 'site1', orgId: ORG_A, name: 'HQ', createdAt: new Date() }]);
  const room = table([
    { id: 'r1', orgId: ORG_A, siteId: 'site1', kind: 'standard' },
    { id: 'r2', orgId: ORG_A, siteId: 'site1', kind: 'standard' },
    { id: 'r3', orgId: ORG_A, siteId: 'site1', kind: 'combined' },
    { id: 'r4', orgId: ORG_B, siteId: 'other', kind: 'standard' },
  ]);
  const gateway = table([
    { id: 'g1', orgId: ORG_A, enrolledAt: new Date(), lastSeenAt: minutesAgo(0.2) },
    { id: 'g2', orgId: ORG_A, enrolledAt: new Date(), lastSeenAt: minutesAgo(30) },
    { id: 'g3', orgId: ORG_B, enrolledAt: null, lastSeenAt: null },
  ]);
  const incident = table([
    { id: 'i1', orgId: ORG_A, status: 'open' },
    { id: 'i2', orgId: ORG_A, status: 'resolved' },
    { id: 'i3', orgId: ORG_B, status: 'open' },
  ]);
  const ticket = table([
    { id: 't1', orgId: ORG_A, status: 'open' },
    { id: 't2', orgId: ORG_A, status: 'closed' },
  ]);
  const auditLog = table([
    { id: 'a1', orgId: ORG_A, action: 'room.create', target: 'r1', createdAt: minutesAgo(90) },
    { id: 'a2', orgId: ORG_A, action: 'room.update', target: 'r1', createdAt: minutesAgo(10) },
  ]);
  return {
    db: {
      staffUser,
      staffAudit,
      org,
      orgBilling,
      member,
      site,
      room,
      gateway,
      incident,
      ticket,
      auditLog,
    } as unknown as StaffDb,
    staffAudit,
  };
}

describe('who is staff', () => {
  it('finds a staff user by their sign-in id, and nobody else', async () => {
    const w = world();
    expect(await findStaff(w.db, STAFF)).toMatchObject({
      email: 'steve@kestrel.test',
      roles: ['admin'],
    });
    expect(await findStaff(w.db, USER)).toBeNull();
  });

  it('admin covers every role; the others cover their own area and looking', () => {
    expect(hasStaffRole(['admin'], 'billing')).toBe(true);
    expect(hasStaffRole(['admin'], 'support')).toBe(true);
    expect(hasStaffRole(['support'], 'support')).toBe(true);
    expect(hasStaffRole(['support'], 'billing')).toBe(false);
    expect(hasStaffRole(['billing'], 'readonly')).toBe(true);
    expect(hasStaffRole(['readonly'], 'support')).toBe(false);
    expect(hasStaffRole([], 'readonly')).toBe(false);
    expect(hasStaffRole(['nonsense'], 'readonly')).toBe(false);
  });

  it('asks for a second factor unless it is switched off on purpose', () => {
    expect(mfaRequired(undefined)).toBe(true);
    expect(mfaRequired('')).toBe(true);
    expect(mfaRequired('true')).toBe(true);
    expect(mfaRequired('false')).toBe(false);
  });
});

describe('the organisation directory', () => {
  it('has one row per organisation with counts, and no customer content', async () => {
    const dir = await orgDirectory(world().db, NOW);
    expect(dir.map((o) => o.name)).toEqual(['Acme', 'Beta', 'Gamma (no billing)']);
    const acme = dir[0]!;
    expect(acme).toMatchObject({
      members: 2,
      plan: 'trial',
      rooms: 2,
      combinedRooms: 1,
      gateways: 2,
      gatewaysOnline: 1,
      openIncidents: 1,
      openTickets: 1,
    });
    expect(acme.lastActivity).toEqual(minutesAgo(10));
  });

  it('counts the days left in a trial, and only for trials', async () => {
    const [acme, beta] = await orgDirectory(world().db, NOW);
    expect(acme!.trialDaysLeft).toBe(5);
    expect(beta!.trialDaysLeft).toBeNull();
    expect(beta).toMatchObject({
      plan: 'pro',
      billingStatus: 'active',
      gateways: 1,
      gatewaysOnline: 0,
    });
  });

  it('shows an organisation with no billing record as plan "none"', async () => {
    const gamma = (await orgDirectory(world().db, NOW))[2]!;
    expect(gamma).toMatchObject({
      plan: 'none',
      billingStatus: 'none',
      rooms: 0,
      lastActivity: null,
    });
  });
});

describe('an organisation page', () => {
  it('shows sites, the team by email and role, and recent activity, newest first', async () => {
    const d = (await orgDetail(world().db, ORG_A, NOW))!;
    expect(d.sites).toEqual([{ id: 'site1', name: 'HQ', rooms: 2 }]);
    expect(d.team.map((t) => `${t.email}:${t.role}`)).toEqual([
      'owner@acme.test:owner',
      'dev@acme.test:dev',
    ]);
    expect(d.recentActivity.map((a) => a.action)).toEqual(['room.update', 'room.create']);
  });

  it('is null for an organisation that does not exist', async () => {
    expect(await orgDetail(world().db, '99999999-9999-4999-8999-999999999999', NOW)).toBeNull();
  });
});

describe('the staff audit trail', () => {
  it('records who did what to which organisation, and shows it on that organisation', async () => {
    const w = world();
    await recordStaffAudit(w.db, {
      staffUserId: STAFF,
      action: 'org.view',
      orgId: ORG_A,
      meta: { reason: 'ticket 12' },
    });
    expect(w.staffAudit.rows).toHaveLength(1);
    expect(w.staffAudit.rows[0]).toMatchObject({
      staffUserId: STAFF,
      action: 'org.view',
      orgId: ORG_A,
    });
    const d = (await orgDetail(w.db, ORG_A, NOW))!;
    expect(d.staffActivity.map((a) => a.action)).toEqual(['org.view']);
    expect((await orgDetail(w.db, ORG_B, NOW))!.staffActivity).toEqual([]);
  });
});
