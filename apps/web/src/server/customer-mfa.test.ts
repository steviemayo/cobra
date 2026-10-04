import { describe, expect, it, vi } from 'vitest';
import {
  MFA_ROLES,
  MfaError,
  mfaGate,
  requiredRolesFor,
  resetMfa,
  setRequireMfa,
  type MfaDb,
} from './customer-mfa';
import type { StaffDb } from './staff';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';
const DEV = '44444444-4444-4444-8444-444444444444';
const STAFF = '55555555-5555-4555-8555-555555555555';

function world(requireMfa = false) {
  const org = table([
    { id: ORG, name: 'Acme', requireMfa },
    { id: OTHER, name: 'Other', requireMfa: false },
  ]);
  const member = table([
    { id: 'm1', orgId: ORG, userId: OWNER, role: 'owner' },
    { id: 'm2', orgId: ORG, userId: DEV, role: 'dev' },
    { id: 'm3', orgId: OTHER, userId: DEV, role: 'support' },
  ]);
  const auditLog = table([]);
  const staffAudit = table([]);
  // The fake has no joins, so `include` is answered here.
  const orgs = org.rows;
  const memberWithOrg = {
    ...member,
    findMany: async (a: { where?: Record<string, unknown> } = {}) =>
      (await member.findMany(a as never)).map((m) => ({
        ...m,
        org: orgs.find((o) => o.id === m.orgId),
      })),
  };
  return {
    db: { org, member: memberWithOrg, auditLog, staffAudit } as unknown as MfaDb & StaffDb,
    org,
    auditLog,
    staffAudit,
  };
}

describe('mfaGate', () => {
  it('asks for a code from anyone with an authenticator app who has not given one this session', () => {
    expect(mfaGate({ hasFactor: true, verified: false, requiredRoles: [] })).toBe('challenge');
    expect(mfaGate({ hasFactor: true, verified: true, requiredRoles: ['owner'] })).toBe('ok');
  });

  it('makes an owner or developer of a requiring organisation set one up', () => {
    expect(mfaGate({ hasFactor: false, verified: false, requiredRoles: ['owner'] })).toBe('enrol');
    expect(mfaGate({ hasFactor: false, verified: false, requiredRoles: ['support', 'dev'] })).toBe(
      'enrol',
    );
  });

  it('leaves everyone else alone', () => {
    expect(mfaGate({ hasFactor: false, verified: false, requiredRoles: [] })).toBe('ok');
    expect(mfaGate({ hasFactor: false, verified: false, requiredRoles: ['support'] })).toBe('ok');
    expect(mfaGate({ hasFactor: false, verified: false, requiredRoles: ['customer_viewer'] })).toBe(
      'ok',
    );
    expect([...MFA_ROLES]).toEqual(['owner', 'dev']);
  });
});

describe('requiredRolesFor', () => {
  it('lists a person roles only in organisations that require it', async () => {
    const off = world(false);
    expect(await requiredRolesFor(off.db, DEV)).toEqual([]);
    const on = world(true);
    expect(await requiredRolesFor(on.db, DEV)).toEqual(['dev']);
    expect(await requiredRolesFor(on.db, OWNER)).toEqual(['owner']);
    expect(await requiredRolesFor(on.db, '99999999-9999-4999-8999-999999999999')).toEqual([]);
  });
});

describe('requiring it', () => {
  const args = { orgId: ORG, userId: OWNER, role: 'owner', on: true, actorHasFactor: true };

  it('is switched on by an owner who has set one up, and audited', async () => {
    const w = world();
    await setRequireMfa(w.db, args);
    expect(w.org.rows[0]!.requireMfa).toBe(true);
    expect(w.auditLog.rows.map((r) => r.action)).toEqual(['security.mfa_required']);
  });

  it('can be switched off again', async () => {
    const w = world(true);
    await setRequireMfa(w.db, { ...args, on: false });
    expect(w.org.rows[0]!.requireMfa).toBe(false);
    expect(w.auditLog.rows.map((r) => r.action)).toEqual(['security.mfa_optional']);
  });

  it('is refused for anyone but an owner', async () => {
    const w = world();
    await expect(setRequireMfa(w.db, { ...args, role: 'dev' })).rejects.toThrow(/Only an owner/);
    expect(w.org.rows[0]!.requireMfa).toBe(false);
  });

  it('is refused when the owner has no authenticator app yet, so they cannot lock themselves out', async () => {
    const w = world();
    await expect(setRequireMfa(w.db, { ...args, actorHasFactor: false })).rejects.toThrow(
      /Set up your own authenticator app first/,
    );
    expect(w.org.rows[0]!.requireMfa).toBe(false);
    // Switching it off never needs one.
    const on = world(true);
    await setRequireMfa(on.db, { ...args, on: false, actorHasFactor: false });
    expect(on.org.rows[0]!.requireMfa).toBe(false);
  });

  it('does nothing, and writes no audit entry, when nothing changes', async () => {
    const w = world(true);
    await setRequireMfa(w.db, args);
    expect(w.auditLog.rows).toHaveLength(0);
  });

  it('only changes the organisation it was asked about', async () => {
    const w = world();
    await setRequireMfa(w.db, args);
    expect(w.org.rows.find((o) => o.id === OTHER)!.requireMfa).toBe(false);
  });
});

describe('staff resetting a lost phone', () => {
  const base = { orgId: ORG, userId: DEV, staffUserId: STAFF, reason: 'Lost their phone' };

  it('clears the factors and records it on both sides', async () => {
    const w = world();
    const clearFactors = vi.fn(async () => 1);
    const res = await resetMfa(w.db, { clearFactors }, base);
    expect(res).toEqual({ removed: 1 });
    expect(clearFactors).toHaveBeenCalledWith(DEV);
    expect(w.auditLog.rows.map((r) => r.action)).toEqual(['security.mfa_reset']);
    expect(w.staffAudit.rows).toHaveLength(1);
    expect(w.staffAudit.rows[0]!.meta).toMatchObject({ reason: 'Lost their phone', userId: DEV });
  });

  it('needs a reason', async () => {
    const w = world();
    const clearFactors = vi.fn(async () => 1);
    await expect(resetMfa(w.db, { clearFactors }, { ...base, reason: 'no' })).rejects.toThrow(
      /at least 5/,
    );
    await expect(
      resetMfa(w.db, { clearFactors }, { ...base, reason: 'x'.repeat(501) }),
    ).rejects.toThrow(/under 500/);
    expect(clearFactors).not.toHaveBeenCalled();
  });

  it('only works on someone who belongs to that organisation', async () => {
    const w = world();
    const clearFactors = vi.fn(async () => 1);
    await expect(
      resetMfa(w.db, { clearFactors }, { ...base, userId: '99999999-9999-4999-8999-999999999999' }),
    ).rejects.toThrow(MfaError);
    expect(clearFactors).not.toHaveBeenCalled();
    expect(w.staffAudit.rows).toHaveLength(0);
  });
});
