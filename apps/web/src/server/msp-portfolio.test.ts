import { describe, expect, it } from 'vitest';
import {
  createCustomer,
  expireGrants,
  healthOf,
  incidentsAcrossCustomers,
  libraryPush,
  portfolio,
  providerActivity,
  setGrantEnd,
  updateCustomerMeta,
  type PortfolioDb,
} from './msp-portfolio';
import { table } from './test-db';

const MSP = '77777777-7777-4777-8777-777777777771';
const A = '11111111-1111-4111-8111-111111111111';
const B = '11111111-1111-4111-8111-111111111112';
const SA = '22222222-2222-4222-8222-222222222221';
const SB1 = '22222222-2222-4222-8222-222222222222';
const SB2 = '22222222-2222-4222-8222-222222222223';
const NOW = new Date('2026-09-30T10:00:00Z');
const recent = new Date(NOW.getTime() - 10_000);
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function world() {
  const org = table([
    { id: MSP, name: 'Provider AV', kind: 'msp' },
    { id: A, name: 'Customer A', kind: 'customer' },
    { id: B, name: 'Customer B', kind: 'customer' },
  ]);
  const mspGrant = table([
    {
      id: 'g1',
      mspOrgId: MSP,
      customerOrgId: A,
      role: 'manage',
      siteIds: [],
      status: 'active',
      createdAt: ago(10),
      endsAt: null,
      accountManager: null,
      tags: [],
    },
    {
      id: 'g2',
      mspOrgId: MSP,
      customerOrgId: B,
      role: 'support',
      siteIds: [SB1],
      status: 'active',
      createdAt: ago(5),
      endsAt: ago(1),
      accountManager: null,
      tags: [],
    },
  ]);
  const site = table([
    { id: SA, orgId: A, name: 'A HQ' },
    { id: SB1, orgId: B, name: 'B one' },
    { id: SB2, orgId: B, name: 'B two' },
  ]);
  const room = table([
    {
      id: 'ra',
      orgId: A,
      siteId: SA,
      name: 'Boardroom',
      gatewayId: 'ga',
      areaId: null,
      tags: [],
      kind: 'standard',
      type: 'meeting',
      updatedAt: NOW,
    },
    {
      id: 'rb1',
      orgId: B,
      siteId: SB1,
      name: 'Studio',
      gatewayId: 'gb1',
      areaId: null,
      tags: [],
      kind: 'standard',
      type: 'meeting',
      updatedAt: NOW,
    },
    {
      id: 'rb2',
      orgId: B,
      siteId: SB2,
      name: 'Hidden',
      gatewayId: 'gb2',
      areaId: null,
      tags: [],
      kind: 'standard',
      type: 'meeting',
      updatedAt: NOW,
    },
  ]);
  const gateway = table([
    {
      id: 'ga',
      orgId: A,
      siteId: SA,
      name: 'GA',
      enrolledAt: ago(9),
      lastSeenAt: recent,
      createdAt: ago(9),
    },
    {
      id: 'gb1',
      orgId: B,
      siteId: SB1,
      name: 'GB1',
      enrolledAt: ago(9),
      lastSeenAt: ago(2),
      createdAt: ago(9),
    },
    {
      id: 'gb2',
      orgId: B,
      siteId: SB2,
      name: 'GB2',
      enrolledAt: ago(9),
      lastSeenAt: recent,
      createdAt: ago(9),
    },
  ]);
  const device = table([
    {
      id: 'da',
      orgId: A,
      siteId: SA,
      roomId: 'ra',
      kind: 'active',
      category: 'display',
      online: true,
      gatewayId: null,
      configState: {},
      feedback: {},
    },
    {
      id: 'db1',
      orgId: B,
      siteId: SB1,
      roomId: 'rb1',
      kind: 'active',
      category: 'display',
      online: true,
      gatewayId: null,
      configState: {},
      feedback: {},
    },
    {
      id: 'db2',
      orgId: B,
      siteId: SB2,
      roomId: 'rb2',
      kind: 'active',
      category: 'display',
      online: false,
      gatewayId: null,
      configState: {},
      feedback: {},
    },
  ]);
  const incident = table([
    {
      id: 'i1',
      orgId: A,
      roomId: 'ra',
      gatewayId: 'ga',
      kind: 'device_offline',
      severity: 'critical',
      status: 'open',
      title: 'Projector offline',
      openedAt: ago(1),
      resolvedAt: null,
    },
    {
      id: 'i2',
      orgId: B,
      roomId: 'rb1',
      gatewayId: 'gb1',
      kind: 'device_offline',
      severity: 'warning',
      status: 'open',
      title: 'Studio display',
      openedAt: ago(2),
      resolvedAt: null,
    },
    {
      id: 'i3',
      orgId: B,
      roomId: 'rb2',
      gatewayId: 'gb2',
      kind: 'device_offline',
      severity: 'warning',
      status: 'open',
      title: 'Hidden room fault',
      openedAt: ago(2),
      resolvedAt: null,
    },
    {
      id: 'i4',
      orgId: A,
      roomId: 'ra',
      gatewayId: 'ga',
      kind: 'device_offline',
      severity: 'info',
      status: 'resolved',
      title: 'Old',
      openedAt: ago(20),
      resolvedAt: ago(3),
    },
  ]);
  const ticket = table([
    { id: 't1', orgId: A, roomId: 'ra', status: 'open', routedTo: `msp:${MSP}` },
    { id: 't2', orgId: A, roomId: 'ra', status: 'open', routedTo: 'org' },
  ]);
  const member = table([
    { id: 'm1', orgId: A, userId: 'owner-a' },
    { id: 'm2', orgId: MSP, userId: 'tech-1' },
  ]);
  const auditLog = table([
    {
      id: 'l1',
      orgId: A,
      actorId: 'tech-1',
      action: 'device.update',
      target: 'x',
      createdAt: ago(1),
    },
    {
      id: 'l2',
      orgId: A,
      actorId: 'owner-a',
      action: 'site.create',
      target: 'y',
      createdAt: ago(1),
    },
    {
      id: 'l3',
      orgId: A,
      actorId: 'tech-1',
      action: 'config.deploy',
      target: 'z',
      createdAt: ago(2),
    },
  ]);
  const invite = table([]);
  const orgBilling = table([]);
  const deviceStatus = table([]);
  const area = table([]);
  const usageDefinition = table([]);
  const pmSchedule = table([]);
  const configProfile = table([
    {
      id: 'cp1',
      orgId: MSP,
      name: 'Meeting display',
      description: 'd',
      category: null,
      params: [{ field: 'power', value: 'on', mode: 'enforce' }],
      version: 3,
    },
  ]);
  const pmTemplate = table([
    {
      id: 'pt1',
      orgId: MSP,
      name: 'Room check',
      appliesTo: 'room',
      category: null,
      items: [{ id: 'a', label: 'A', type: 'passfail' }],
      version: 2,
    },
  ]);
  const db = {
    org,
    mspGrant,
    site,
    room,
    gateway,
    device,
    incident,
    ticket,
    member,
    auditLog,
    invite,
    orgBilling,
    deviceStatus,
    area,
    usageDefinition,
    pmSchedule,
    configProfile,
    pmTemplate,
  } as unknown as PortfolioDb;
  return { db, org, mspGrant, incident, invite, orgBilling, configProfile, pmTemplate, auditLog };
}

describe('portfolio', () => {
  it('reads each customer with the scope of its grant, and never the provider itself', async () => {
    const w = world();
    const rows = await portfolio(w.db, MSP, NOW);
    expect(rows.map((r) => r.name)).toEqual(['Customer A', 'Customer B']);
    const a = rows[0]!;
    expect(a).toMatchObject({
      rooms: 1,
      devicesActive: 1,
      devicesOnline: 1,
      liveIncidents: 1,
      criticalIncidents: 1,
      ticketsWithUs: 1,
      gateways: 1,
      gatewaysOnline: 1,
    });
    expect(a.health).toBe('down');
    const b = rows[1]!;
    // Limited to one site: the other site's room, gateway and incident are not counted.
    expect(b).toMatchObject({
      rooms: 1,
      gateways: 1,
      liveIncidents: 1,
      limitedToSites: 1,
      devicesActive: 1,
    });
    expect(b.gatewaysOnline).toBe(0);
    expect(b.health).toBe('degraded');
  });

  it('works out a health level from the numbers', () => {
    const base = {
      criticalIncidents: 0,
      roomsNeedingAttention: 0,
      driftCount: 0,
      pmOverdue: 0,
      gateways: 1,
      gatewaysOnline: 1,
      roomsMonitored: 2,
    };
    expect(healthOf(base)).toBe('healthy');
    expect(healthOf({ ...base, criticalIncidents: 1 })).toBe('down');
    expect(healthOf({ ...base, pmOverdue: 1 })).toBe('degraded');
    expect(healthOf({ ...base, gatewaysOnline: 0 })).toBe('degraded');
    expect(healthOf({ ...base, roomsMonitored: 0 })).toBe('unknown');
  });

  it('lists every open incident across customers, most serious first, within each grant scope', async () => {
    const w = world();
    const list = await incidentsAcrossCustomers(w.db, MSP, NOW);
    expect(list.map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(list[0]).toMatchObject({ customerName: 'Customer A', roomName: 'Boardroom' });
    const withResolved = await incidentsAcrossCustomers(w.db, MSP, NOW, true);
    expect(withResolved.map((i) => i.id)).toContain('i4');
  });
});

describe('what the provider did', () => {
  it('shows a customer only the actions of people from its providers', async () => {
    const w = world();
    const rows = await providerActivity(w.db, A);
    expect(rows.map((r) => r.action)).toEqual(['device.update', 'config.deploy']);
    expect(rows[0]).toMatchObject({ provider: 'Provider AV' });
    expect(await providerActivity(w.db, B)).toEqual([]);
  });
});

describe('grants', () => {
  it('ends a connection by itself when its end date passes', async () => {
    const w = world();
    expect(await expireGrants(w.db, NOW)).toBe(1);
    expect(w.mspGrant.rows.find((g) => g.id === 'g2')).toMatchObject({ status: 'ended' });
    expect(w.mspGrant.rows.find((g) => g.id === 'g1')!.status).toBe('active');
    expect(await expireGrants(w.db, NOW)).toBe(0);
    expect((await portfolio(w.db, MSP, NOW)).map((r) => r.name)).toEqual(['Customer A']);
  });

  it('lets the customer set an end date in the future, and refuses the past', async () => {
    const w = world();
    const future = new Date(NOW.getTime() + 30 * 86_400_000);
    expect(
      (await setGrantEnd(w.db, { customerOrgId: A, grantId: 'g1', endsAt: future }, NOW)).ok,
    ).toBe(true);
    expect(w.mspGrant.rows[0]!.endsAt).toEqual(future);
    expect(
      (await setGrantEnd(w.db, { customerOrgId: A, grantId: 'g1', endsAt: ago(1) }, NOW)).ok,
    ).toBe(false);
    expect(
      (await setGrantEnd(w.db, { customerOrgId: A, grantId: 'g1', endsAt: null }, NOW)).ok,
    ).toBe(true);
    expect(
      (await setGrantEnd(w.db, { customerOrgId: B, grantId: 'g1', endsAt: future }, NOW)).ok,
    ).toBe(false);
  });

  it('keeps the provider notes on a customer, trimmed and de-duplicated', async () => {
    const w = world();
    expect(
      (
        await updateCustomerMeta(w.db, {
          mspOrgId: MSP,
          grantId: 'g1',
          accountManager: ' Sam ',
          tags: ['gold', 'gold', ' vic ', ''],
        })
      ).ok,
    ).toBe(true);
    expect(w.mspGrant.rows[0]).toMatchObject({ accountManager: 'Sam', tags: ['gold', 'vic'] });
    expect(
      (await updateCustomerMeta(w.db, { mspOrgId: A, grantId: 'g1', accountManager: 'x' })).ok,
    ).toBe(false);
  });
});

describe('the provider library', () => {
  it('copies a profile and a checklist to customers that let the provider manage them, and skips the rest', async () => {
    const w = world();
    const r = await libraryPush(w.db, {
      mspOrgId: MSP,
      kind: 'profile',
      sourceId: 'cp1',
      customerOrgIds: [A, B, '99999999-9999-4999-8999-999999999999'],
      userId: 'u1',
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.value.copied.map((c) => c.orgId)).toEqual([A]);
    expect(r.value.skipped.map((s) => s.reason)).toEqual([
      'You only have support or view access',
      'Not connected',
    ]);
    expect(w.configProfile.rows.filter((p) => p.orgId === A)).toHaveLength(1);
    expect(w.configProfile.rows.find((p) => p.orgId === A)).toMatchObject({
      name: 'Meeting display',
      version: 1,
    });
    // A second push does not overwrite: the customer's copy is its own.
    await libraryPush(w.db, {
      mspOrgId: MSP,
      kind: 'profile',
      sourceId: 'cp1',
      customerOrgIds: [A],
      userId: 'u1',
    });
    expect(w.configProfile.rows.filter((p) => p.orgId === A).map((p) => p.name)).toEqual([
      'Meeting display',
      'Meeting display (from Provider AV)',
    ]);
    const t = await libraryPush(w.db, {
      mspOrgId: MSP,
      kind: 'pm_template',
      sourceId: 'pt1',
      customerOrgIds: [A],
      userId: 'u1',
    });
    expect(t.ok).toBe(true);
    expect(w.pmTemplate.rows.filter((p) => p.orgId === A)).toHaveLength(1);
  });

  it('refuses something that is not in the provider library, or from a non-provider', async () => {
    const w = world();
    expect(
      (
        await libraryPush(w.db, {
          mspOrgId: MSP,
          kind: 'profile',
          sourceId: 'nope',
          customerOrgIds: [A],
          userId: null,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await libraryPush(w.db, {
          mspOrgId: A,
          kind: 'profile',
          sourceId: 'cp1',
          customerOrgIds: [B],
          userId: null,
        })
      ).ok,
    ).toBe(false);
  });
});

describe('creating a customer', () => {
  it('makes an organisation with a trial, connects the provider, and invites the owner', async () => {
    const w = world();
    const r = await createCustomer(
      w.db,
      {
        mspOrgId: MSP,
        name: '  New Co ',
        ownerEmail: 'Boss@NewCo.com',
        by: { userId: 'tech-1', email: 't@p.com' },
      },
      NOW,
    );
    if (!r.ok) throw new Error(r.message);
    expect(r.value.inviteToken).toBeTruthy();
    const org = w.org.rows.find((o) => o.id === r.value.id)!;
    expect(org).toMatchObject({ name: 'New Co', kind: 'customer' });
    expect(w.mspGrant.rows.find((g) => g.customerOrgId === r.value.id)).toMatchObject({
      mspOrgId: MSP,
      role: 'manage',
      status: 'active',
    });
    expect(w.invite.rows[0]).toMatchObject({
      orgId: r.value.id,
      email: 'boss@newco.com',
      role: 'owner',
    });
    expect(w.invite.rows[0]!.tokenHash).not.toBe(r.value.inviteToken);
    expect(w.auditLog.rows.some((a) => a.action === 'org.create_by_provider')).toBe(true);
  });

  it('works without an owner to invite, and refuses a blank name or a customer as the creator', async () => {
    const w = world();
    const r = await createCustomer(
      w.db,
      { mspOrgId: MSP, name: 'Solo', by: { userId: 'u', email: null } },
      NOW,
    );
    expect(r).toMatchObject({ ok: true, value: { inviteToken: null } });
    expect(
      (await createCustomer(w.db, { mspOrgId: MSP, name: '  ', by: { userId: 'u', email: null } }))
        .ok,
    ).toBe(false);
    expect(
      (await createCustomer(w.db, { mspOrgId: A, name: 'X', by: { userId: 'u', email: null } })).ok,
    ).toBe(false);
  });
});
