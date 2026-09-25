import { describe, expect, it } from 'vitest';
import {
  MspError,
  endGrant,
  grantsForCustomer,
  inviteMsp,
  managedCustomers,
  managedOverview,
  mspAccess,
  mspTickets,
  pendingInvites,
  respondToInvite,
  routeForNewTicket,
  type MspDb,
} from './msp';
import { table } from './test-db';

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const CUSTOMER2 = '11111111-1111-4111-8111-111111111112';
const MSP = '22222222-2222-4222-8222-222222222221';
const MSP2 = '22222222-2222-4222-8222-222222222222';
const ALICE = '44444444-4444-4444-8444-444444444441'; // owner of MSP
const BOB = '44444444-4444-4444-8444-444444444442'; // support at MSP
const CAROL = '44444444-4444-4444-8444-444444444443'; // owner of customer only
const NOW = new Date('2026-09-26T00:00:00Z');

function world() {
  let n = 0;
  const withIds = <T extends ReturnType<typeof table>>(t: T, p: string): T => {
    const create = t.create;
    t.create = async (args: { data: Record<string, unknown> }) =>
      create({
        data: {
          id: `${p}-${++n}`,
          createdAt: new Date(NOW.getTime() + n * 1000),
          siteIds: [],
          ...args.data,
        },
      });
    return t;
  };
  const org = table([
    { id: CUSTOMER, name: 'Acme', kind: 'customer' },
    { id: CUSTOMER2, name: 'Beta', kind: 'customer' },
    { id: MSP, name: 'AV Partners', kind: 'msp' },
    { id: MSP2, name: 'Other MSP', kind: 'msp' },
  ]);
  const member = table([
    { orgId: MSP, userId: ALICE, role: 'owner' },
    { orgId: MSP, userId: BOB, role: 'support' },
    { orgId: CUSTOMER, userId: CAROL, role: 'owner' },
    { orgId: MSP2, userId: ALICE, role: 'customer_viewer' },
  ]);
  const mspGrant = withIds(table([]), 'g');
  const auditLog = withIds(table([]), 'a');
  const ticket = table([]);
  const room = table([
    { id: 'r1', orgId: CUSTOMER, kind: 'standard' },
    { id: 'r2', orgId: CUSTOMER, kind: 'combined' },
    { id: 'r3', orgId: CUSTOMER2, kind: 'standard' },
  ]);
  const gateway = table([
    { id: 'gw1', orgId: CUSTOMER, enrolledAt: NOW, lastSeenAt: NOW },
    {
      id: 'gw2',
      orgId: CUSTOMER,
      enrolledAt: NOW,
      lastSeenAt: new Date(NOW.getTime() - 3_600_000),
    },
  ]);
  const incident = table([{ id: 'i1', orgId: CUSTOMER, status: 'open' }]);
  return {
    db: { org, member, mspGrant, auditLog, ticket, room, gateway, incident } as unknown as MspDb,
    mspGrant,
    auditLog,
    ticket,
  };
}

const carol = { userId: CAROL, email: 'carol@acme.test' };
const connect = async (
  w: ReturnType<typeof world>,
  role: 'manage' | 'support' | 'view' = 'manage',
  customer = CUSTOMER,
) => {
  const { id } = await inviteMsp(w.db, { customerOrgId: customer, mspOrgId: MSP, role, by: carol });
  await respondToInvite(w.db, { grantId: id, mspOrgId: MSP, accept: true, by: ALICE, now: NOW });
  return id;
};

describe('inviting a provider', () => {
  it('creates a pending invitation the provider has to accept', async () => {
    const w = world();
    await inviteMsp(w.db, { customerOrgId: CUSTOMER, mspOrgId: MSP, role: 'manage', by: carol });
    expect(w.mspGrant.rows[0]).toMatchObject({
      status: 'pending',
      role: 'manage',
      invitedBy: CAROL,
    });
    expect(await pendingInvites(w.db, MSP)).toMatchObject([
      { customerName: 'Acme', role: 'manage', invitedByEmail: 'carol@acme.test' },
    ]);
    // Pending is not access.
    expect(await mspAccess(w.db, ALICE, CUSTOMER)).toBeNull();
  });

  it('needs a real provider code, and a customer as the inviter', async () => {
    const w = world();
    await expect(
      inviteMsp(w.db, { customerOrgId: CUSTOMER, mspOrgId: CUSTOMER2, role: 'view', by: carol }),
    ).rejects.toThrow(/No service provider/);
    await expect(
      inviteMsp(w.db, { customerOrgId: CUSTOMER, mspOrgId: 'nonsense', role: 'view', by: carol }),
    ).rejects.toThrow(MspError);
    await expect(
      inviteMsp(w.db, { customerOrgId: MSP2, mspOrgId: MSP, role: 'view', by: carol }),
    ).rejects.toThrow(/Only a customer/);
  });

  it('cannot be sent twice while one is waiting or active', async () => {
    const w = world();
    await inviteMsp(w.db, { customerOrgId: CUSTOMER, mspOrgId: MSP, role: 'view', by: carol });
    await expect(
      inviteMsp(w.db, { customerOrgId: CUSTOMER, mspOrgId: MSP, role: 'view', by: carol }),
    ).rejects.toThrow(/not answered/);
    const g = w.mspGrant.rows[0]!;
    await respondToInvite(w.db, {
      grantId: g.id as string,
      mspOrgId: MSP,
      accept: true,
      by: ALICE,
    });
    await expect(
      inviteMsp(w.db, { customerOrgId: CUSTOMER, mspOrgId: MSP, role: 'view', by: carol }),
    ).rejects.toThrow(/already looks after/);
  });

  it('is written to both organisations’ activity logs', async () => {
    const w = world();
    await inviteMsp(w.db, { customerOrgId: CUSTOMER, mspOrgId: MSP, role: 'support', by: carol });
    expect(
      w.auditLog.rows.map((r) => `${r.orgId === CUSTOMER ? 'customer' : 'msp'}:${r.action}`),
    ).toEqual(['customer:msp.invite', 'msp:msp.invited']);
  });
});

describe('answering an invitation', () => {
  it('accepting makes it active; declining ends it and gives no access', async () => {
    const w = world();
    await connect(w);
    expect(w.mspGrant.rows[0]).toMatchObject({ status: 'active', respondedBy: ALICE });

    const w2 = world();
    const { id } = await inviteMsp(w2.db, {
      customerOrgId: CUSTOMER,
      mspOrgId: MSP,
      role: 'manage',
      by: carol,
    });
    await respondToInvite(w2.db, { grantId: id, mspOrgId: MSP, accept: false, by: ALICE });
    expect(w2.mspGrant.rows[0]!.status).toBe('declined');
    expect(await mspAccess(w2.db, ALICE, CUSTOMER)).toBeNull();
  });

  it('only the invited provider can answer, and only once', async () => {
    const w = world();
    const { id } = await inviteMsp(w.db, {
      customerOrgId: CUSTOMER,
      mspOrgId: MSP,
      role: 'manage',
      by: carol,
    });
    await expect(
      respondToInvite(w.db, { grantId: id, mspOrgId: MSP2, accept: true, by: ALICE }),
    ).rejects.toThrow(/no longer waiting/);
    await respondToInvite(w.db, { grantId: id, mspOrgId: MSP, accept: true, by: ALICE });
    await expect(
      respondToInvite(w.db, { grantId: id, mspOrgId: MSP, accept: true, by: ALICE }),
    ).rejects.toThrow(MspError);
  });
});

describe('what a provider’s people can do in a customer', () => {
  it('is the lower of their role in the provider and the grant, never owner', async () => {
    const w = world();
    await connect(w, 'manage');
    expect(await mspAccess(w.db, ALICE, CUSTOMER)).toMatchObject({
      role: 'dev',
      mspName: 'AV Partners',
    });
    expect(await mspAccess(w.db, BOB, CUSTOMER)).toMatchObject({ role: 'support' });
  });

  it('a support grant limits even the provider’s owner; a view grant is view only', async () => {
    const a = world();
    await connect(a, 'support');
    expect((await mspAccess(a.db, ALICE, CUSTOMER))!.role).toBe('support');
    const b = world();
    await connect(b, 'view');
    expect((await mspAccess(b.db, ALICE, CUSTOMER))!.role).toBe('customer_viewer');
  });

  it('gives nothing to people outside the provider, for other customers, or after it ends', async () => {
    const w = world();
    const id = await connect(w);
    expect(await mspAccess(w.db, CAROL, CUSTOMER)).toBeNull(); // the customer's own owner is not via the provider
    expect(await mspAccess(w.db, ALICE, CUSTOMER2)).toBeNull(); // a different customer
    expect(await mspAccess(w.db, 'stranger', CUSTOMER)).toBeNull();
    await endGrant(w.db, { grantId: id, orgId: MSP, by: ALICE });
    expect(await mspAccess(w.db, ALICE, CUSTOMER)).toBeNull();
  });

  it('a provider where you are only a viewer gives a viewer, and being a member of another provider does not help', async () => {
    const w = world();
    await connect(w, 'manage');
    // Alice is also a customer_viewer at MSP2, which has no grant: irrelevant.
    expect((await mspAccess(w.db, ALICE, CUSTOMER))!.mspOrgId).toBe(MSP);
  });

  it('site-limited grants give no access yet', async () => {
    const w = world();
    await connect(w);
    w.mspGrant.rows[0]!.siteIds = ['site-1'];
    expect(await mspAccess(w.db, ALICE, CUSTOMER)).toBeNull();
    expect(await managedCustomers(w.db, ALICE)).toEqual([]);
  });

  it('lists the customers someone can work in, for the organisation switcher', async () => {
    const w = world();
    await connect(w, 'manage', CUSTOMER);
    await connect(w, 'support', CUSTOMER2);
    const list = await managedCustomers(w.db, BOB);
    expect(list.map((c) => `${c.name}:${c.role}`)).toEqual(['Acme:support', 'Beta:support']);
    expect((await managedCustomers(w.db, ALICE)).map((c) => `${c.name}:${c.role}`)).toEqual([
      'Acme:dev',
      'Beta:support',
    ]);
    expect(await managedCustomers(w.db, CAROL)).toEqual([]);
  });
});

describe('ending the relationship', () => {
  it('either side can end it, and it is recorded on both', async () => {
    const w = world();
    const id = await connect(w);
    await endGrant(w.db, { grantId: id, orgId: CUSTOMER, by: CAROL });
    expect(w.mspGrant.rows[0]).toMatchObject({ status: 'ended', endedBy: CAROL });
    expect(w.auditLog.rows.filter((r) => r.action === 'msp.ended')).toHaveLength(2);
  });

  it('a stranger cannot end it, and it cannot be ended twice', async () => {
    const w = world();
    const id = await connect(w);
    await expect(endGrant(w.db, { grantId: id, orgId: CUSTOMER2, by: 'x' })).rejects.toThrow(
      /not found/,
    );
    await endGrant(w.db, { grantId: id, orgId: MSP, by: ALICE });
    await expect(endGrant(w.db, { grantId: id, orgId: MSP, by: ALICE })).rejects.toThrow(MspError);
  });

  it('tickets that were with the provider go back to the organisation’s team', async () => {
    const w = world();
    const id = await connect(w);
    w.ticket.rows.push(
      { id: 't1', orgId: CUSTOMER, routedTo: `msp:${MSP}`, status: 'open' },
      { id: 't2', orgId: CUSTOMER, routedTo: 'kestrel', status: 'open' },
    );
    await endGrant(w.db, { grantId: id, orgId: CUSTOMER, by: CAROL });
    expect(w.ticket.rows.map((t) => t.routedTo)).toEqual(['org', 'kestrel']);
  });

  it('a customer sees only live connections', async () => {
    const w = world();
    const id = await connect(w);
    expect((await grantsForCustomer(w.db, CUSTOMER)).map((g) => g.status)).toEqual(['active']);
    await endGrant(w.db, { grantId: id, orgId: CUSTOMER, by: CAROL });
    expect(await grantsForCustomer(w.db, CUSTOMER)).toEqual([]);
  });
});

describe('where new tickets go', () => {
  it('to the provider when there is an active one that takes tickets', async () => {
    const w = world();
    expect(await routeForNewTicket(w.db, CUSTOMER)).toBe('org');
    await connect(w, 'support');
    expect(await routeForNewTicket(w.db, CUSTOMER)).toBe(`msp:${MSP}`);
  });

  it('not to a view-only provider, and not while the invitation is pending', async () => {
    const w = world();
    await connect(w, 'view');
    expect(await routeForNewTicket(w.db, CUSTOMER)).toBe('org');
    const w2 = world();
    await inviteMsp(w2.db, { customerOrgId: CUSTOMER, mspOrgId: MSP, role: 'manage', by: carol });
    expect(await routeForNewTicket(w2.db, CUSTOMER)).toBe('org');
  });
});

describe('the provider’s view', () => {
  it('shows each customer with the numbers that matter, counting only ordinary rooms', async () => {
    const w = world();
    await connect(w, 'manage', CUSTOMER);
    await connect(w, 'support', CUSTOMER2);
    w.ticket.rows.push(
      {
        id: 't1',
        orgId: CUSTOMER,
        routedTo: `msp:${MSP}`,
        status: 'open',
        title: 'A',
        priority: 'normal',
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 't2',
        orgId: CUSTOMER,
        routedTo: 'org',
        status: 'open',
        title: 'B',
        priority: 'normal',
        createdAt: NOW,
        updatedAt: NOW,
      },
    );
    const rows = await managedOverview(w.db, MSP, NOW);
    expect(rows.map((r) => r.name)).toEqual(['Acme', 'Beta']);
    expect(rows[0]).toMatchObject({
      rooms: 1,
      gateways: 2,
      gatewaysOnline: 1,
      openIncidents: 1,
      ticketsWithUs: 1,
    });
    expect(rows[1]).toMatchObject({ rooms: 1, gateways: 0, ticketsWithUs: 0 });
  });

  it('lists only tickets routed to this provider, most urgent first', async () => {
    const w = world();
    await connect(w);
    const t = (id: string, priority: string, routedTo = `msp:${MSP}`, orgId = CUSTOMER) => ({
      id,
      orgId,
      routedTo,
      priority,
      status: 'open',
      title: id,
      createdAt: NOW,
      updatedAt: NOW,
    });
    w.ticket.rows.push(
      t('normal', 'normal'),
      t('urgent', 'urgent'),
      t('theirs', 'urgent', 'org'),
      t('other-msp', 'urgent', `msp:${MSP2}`),
      t('not-mine', 'urgent', `msp:${MSP}`, CUSTOMER2),
    );
    expect((await mspTickets(w.db, MSP)).map((r) => r.id)).toEqual(['urgent', 'normal']);
  });
});
