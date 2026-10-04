import { describe, expect, it } from 'vitest';
import {
  ProviderMemberError,
  addContext,
  addedByProvider,
  inviteViaProvider,
  revokeViaProvider,
  rolesProviderMayGive,
  setMayAddPeople,
  type ProviderMembersDb,
} from './provider-members';
import { table } from './test-db';

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const MSP = '22222222-2222-4222-8222-222222222222';
const OTHER_MSP = '88888888-8888-4888-8888-888888888888';
const MSP_OWNER = '33333333-3333-4333-8333-333333333333';
const MSP_TECH = '44444444-4444-4444-8444-444444444444';
const CUSTOMER_OWNER = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-04T10:00:00Z');

function world(
  opts: {
    grant?: Record<string, unknown> | null;
    customerMembers?: Record<string, unknown>[];
  } = {},
) {
  const org = table([
    { id: CUSTOMER, name: 'Acme', kind: 'customer' },
    { id: MSP, name: 'Best AV', kind: 'msp' },
    { id: OTHER_MSP, name: 'Other AV', kind: 'msp' },
  ]);
  const member = table([
    { id: 'p1', orgId: MSP, userId: MSP_OWNER, role: 'owner', email: 'boss@bestav.test' },
    { id: 'p2', orgId: MSP, userId: MSP_TECH, role: 'dev', email: 'tech@bestav.test' },
    ...(opts.customerMembers ?? [
      { id: 'c1', orgId: CUSTOMER, userId: CUSTOMER_OWNER, role: 'owner', email: 'o@acme.test' },
    ]),
  ]);
  const invite = table([]);
  const mspGrant = table(
    opts.grant === null
      ? []
      : [
          {
            id: 'g1',
            mspOrgId: MSP,
            customerOrgId: CUSTOMER,
            role: 'manage',
            siteIds: [],
            status: 'active',
            endsAt: null,
            mayAddPeople: true,
            ...opts.grant,
          },
        ],
  );
  const auditLog = table([]);
  return {
    db: { org, member, invite, mspGrant, auditLog } as unknown as ProviderMembersDb,
    member,
    invite,
    mspGrant,
    auditLog,
  };
}

const base = { mspOrgId: MSP, customerOrgId: CUSTOMER, userId: MSP_OWNER, now: NOW };
const send = (w: ReturnType<typeof world>, over: Record<string, unknown> = {}) =>
  inviteViaProvider(w.db, {
    ...base,
    email: 'New.Person@acme.test',
    role: 'support',
    ...over,
  } as never);

describe('which roles a provider may give', () => {
  it('always viewer and support, owner or developer only when the customer has none', () => {
    expect(rolesProviderMayGive({ hasOwner: true, hasDev: true })).toEqual([
      'customer_viewer',
      'support',
    ]);
    expect(rolesProviderMayGive({ hasOwner: true, hasDev: false })).toEqual([
      'customer_viewer',
      'support',
      'dev',
    ]);
    expect(rolesProviderMayGive({ hasOwner: false, hasDev: true })).toEqual([
      'customer_viewer',
      'support',
      'owner',
    ]);
    expect(rolesProviderMayGive({ hasOwner: false, hasDev: false })).toEqual([
      'customer_viewer',
      'support',
      'dev',
      'owner',
    ]);
  });
});

describe('who may add people', () => {
  it('allows a provider owner with a Manage connection to the whole organisation that the customer permitted', async () => {
    const w = world();
    const c = await addContext(w.db, base);
    expect(c.blocked).toBeNull();
    expect(c.mspName).toBe('Best AV');
    // The customer already has an owner but no developer.
    expect(c.roles).toEqual(['customer_viewer', 'support', 'dev']);
  });

  it('refuses anyone in the provider who is not an owner', async () => {
    const w = world();
    const c = await addContext(w.db, { ...base, userId: MSP_TECH });
    expect(c.blocked).toMatch(/Only an owner of your organisation/);
    expect(c.roles).toEqual([]);
  });

  it('refuses a customer organisation acting as a provider, and a stranger', async () => {
    const w = world();
    expect((await addContext(w.db, { ...base, mspOrgId: CUSTOMER })).blocked).toMatch(
      /Only a service provider/,
    );
    expect(
      (await addContext(w.db, { ...base, userId: '99999999-9999-4999-8999-999999999999' })).blocked,
    ).toMatch(/Only an owner/);
  });

  it('refuses without a live connection', async () => {
    expect((await addContext(world({ grant: null }).db, base)).blocked).toMatch(/not connected/);
    expect((await addContext(world({ grant: { status: 'ended' } }).db, base)).blocked).toMatch(
      /not connected/,
    );
    expect(
      (await addContext(world({ grant: { endsAt: new Date('2026-10-01T00:00:00Z') } }).db, base))
        .blocked,
    ).toMatch(/not connected/);
    expect(
      (await addContext(world().db, { ...base, mspOrgId: OTHER_MSP, userId: MSP_OWNER })).blocked,
    ).toBeTruthy();
  });

  it('refuses a support or view connection and one limited to some sites', async () => {
    for (const grant of [{ role: 'support' }, { role: 'view' }, { siteIds: ['s1'] }])
      expect((await addContext(world({ grant }).db, base)).blocked).toMatch(/Manage connection/);
  });

  it('refuses until the customer owner has allowed it', async () => {
    const w = world({ grant: { mayAddPeople: false } });
    expect((await addContext(w.db, base)).blocked).toMatch(/has not allowed/);
    await expect(send(w)).rejects.toThrow(/has not allowed/);
    expect(w.invite.rows).toHaveLength(0);
  });
});

describe('inviting', () => {
  it('creates an invitation tied to the provider, keeps only a hash, and audits both sides', async () => {
    const w = world();
    const res = await send(w);
    expect(res.token.length).toBeGreaterThan(20);
    const row = w.invite.rows[0]!;
    expect(row).toMatchObject({
      orgId: CUSTOMER,
      email: 'new.person@acme.test',
      role: 'support',
      invitedBy: MSP_OWNER,
      viaMspOrgId: MSP,
    });
    expect(row.tokenHash).not.toBe(res.token);
    expect(String(row.tokenHash)).toMatch(/^[0-9a-f]{64}$/);
    expect((row.expiresAt as Date).getTime()).toBe(NOW.getTime() + 7 * 86_400_000);
    const actions = w.auditLog.rows.map(
      (r) => `${r.orgId === CUSTOMER ? 'customer' : 'provider'}:${r.action}`,
    );
    expect(actions).toEqual([
      'customer:invite.create_by_provider',
      'provider:invite.create_for_customer',
    ]);
    // The customer's owners see which provider did it.
    expect(w.auditLog.rows[0]!.meta).toMatchObject({ provider: 'Best AV', role: 'support' });
  });

  it('gives owner or developer only when the customer has none', async () => {
    const hasBoth = world({
      customerMembers: [
        { id: 'c1', orgId: CUSTOMER, userId: CUSTOMER_OWNER, role: 'owner', email: 'o@acme.test' },
        { id: 'c2', orgId: CUSTOMER, userId: 'd1', role: 'dev', email: 'd@acme.test' },
      ],
    });
    await expect(send(hasBoth, { role: 'owner' })).rejects.toThrow(/already has an owner/);
    await expect(send(hasBoth, { role: 'dev' })).rejects.toThrow(/already has a developer/);
    expect(hasBoth.invite.rows).toHaveLength(0);

    const noOwner = world({ customerMembers: [] });
    expect((await send(noOwner, { role: 'owner' })).id).toBeTruthy();
    expect(noOwner.invite.rows[0]!.role).toBe('owner');

    const noDev = world();
    expect((await send(noDev, { role: 'dev' })).id).toBeTruthy();
  });

  it('refuses someone who is already a member', async () => {
    const w = world();
    await expect(send(w, { email: 'o@acme.test' })).rejects.toThrow(/already a member/);
  });

  it('replaces an open invitation to the same address', async () => {
    const w = world();
    await send(w);
    await send(w, { role: 'customer_viewer' });
    const open = w.invite.rows.filter((r) => !r.revokedAt);
    expect(open).toHaveLength(1);
    expect(open[0]!.role).toBe('customer_viewer');
  });

  it('is refused for anyone the rules refuse, writing nothing', async () => {
    const w = world();
    await expect(send(w, { userId: MSP_TECH })).rejects.toThrow(ProviderMemberError);
    expect(w.invite.rows).toHaveLength(0);
    expect(w.auditLog.rows).toHaveLength(0);
  });
});

describe('withdrawing and listing', () => {
  it('lets the provider withdraw its own open invitation only', async () => {
    const w = world();
    const { id } = await send(w);
    // An invitation the customer's owner sent is not the provider's to withdraw.
    w.invite.rows.push({
      id: 'owner-sent',
      orgId: CUSTOMER,
      email: 'x@acme.test',
      role: 'support',
      viaMspOrgId: null,
      acceptedAt: null,
      revokedAt: null,
    });
    await expect(revokeViaProvider(w.db, { ...base, inviteId: 'owner-sent' })).rejects.toThrow(
      /not found/,
    );
    await revokeViaProvider(w.db, { ...base, inviteId: id });
    expect(w.invite.rows.find((r) => r.id === id)!.revokedAt).toEqual(NOW);
    expect(w.auditLog.rows.some((r) => r.action === 'invite.revoke_by_provider')).toBe(true);
  });

  it('lists the people this provider added and its open invitations, not another provider', async () => {
    const w = world();
    await send(w);
    w.member.rows.push(
      {
        id: 'c9',
        orgId: CUSTOMER,
        userId: 'u9',
        role: 'support',
        email: 'added@acme.test',
        createdAt: NOW,
        addedByMspOrgId: MSP,
      },
      {
        id: 'c10',
        orgId: CUSTOMER,
        userId: 'u10',
        role: 'support',
        email: 'other@acme.test',
        createdAt: NOW,
        addedByMspOrgId: OTHER_MSP,
      },
    );
    const view = await addedByProvider(w.db, MSP, CUSTOMER, NOW);
    expect(view.members.map((m) => m.email)).toEqual(['added@acme.test']);
    expect(view.pending).toHaveLength(1);
    expect(view.pending[0]).toMatchObject({ email: 'new.person@acme.test', expired: false });
    const later = await addedByProvider(
      w.db,
      MSP,
      CUSTOMER,
      new Date(NOW.getTime() + 8 * 86_400_000),
    );
    expect(later.pending[0]!.expired).toBe(true);
  });
});

describe('the customer owner allowing it', () => {
  const args = { customerOrgId: CUSTOMER, grantId: 'g1', userId: CUSTOMER_OWNER };

  it('turns it on and off, audited on both sides', async () => {
    const w = world({ grant: { mayAddPeople: false } });
    await setMayAddPeople(w.db, { ...args, on: true });
    expect(w.mspGrant.rows[0]!.mayAddPeople).toBe(true);
    await setMayAddPeople(w.db, { ...args, on: false });
    expect(w.mspGrant.rows[0]!.mayAddPeople).toBe(false);
    expect(w.auditLog.rows.map((r) => r.action)).toEqual([
      'msp.add_people_allowed',
      'msp.add_people_allowed',
      'msp.add_people_stopped',
      'msp.add_people_stopped',
    ]);
  });

  it('does nothing when nothing changes', async () => {
    const w = world();
    await setMayAddPeople(w.db, { ...args, on: true });
    expect(w.auditLog.rows).toHaveLength(0);
  });

  it('cannot be turned on for a support, view or site-limited connection', async () => {
    for (const grant of [{ role: 'support' }, { role: 'view' }, { siteIds: ['s1'] }]) {
      const w = world({ grant: { ...grant, mayAddPeople: false } });
      await expect(setMayAddPeople(w.db, { ...args, on: true })).rejects.toThrow(
        /Manage connection/,
      );
      expect(w.mspGrant.rows[0]!.mayAddPeople).toBe(false);
    }
  });

  it('only works on this customer, and a connection that exists', async () => {
    const w = world();
    await expect(
      setMayAddPeople(w.db, {
        ...args,
        customerOrgId: '99999999-9999-4999-8999-999999999999',
        on: false,
      }),
    ).rejects.toThrow(/not found/);
    await expect(setMayAddPeople(w.db, { ...args, grantId: 'nope', on: false })).rejects.toThrow(
      /not found/,
    );
  });
});
