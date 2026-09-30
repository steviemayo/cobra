import { describe, expect, it } from 'vitest';
import { estateOverview, type EstateDb } from './estate-overview';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const SITE2 = '22222222-2222-4222-8222-222222222223';
const R1 = '33333333-3333-4333-8333-333333333331';
const R2 = '33333333-3333-4333-8333-333333333332';
const R3 = '33333333-3333-4333-8333-333333333333';
const G1 = '99999999-9999-4999-8999-999999999991';
const G2 = '99999999-9999-4999-8999-999999999992';
const AREA = '55555555-5555-4555-8555-555555555551';
const CHILD = '55555555-5555-4555-8555-555555555552';
const NOW = new Date('2026-09-30T10:00:00Z');
const recent = new Date(NOW.getTime() - 10_000);
const old = new Date(NOW.getTime() - 3_600_000);

function world() {
  const room = table([
    {
      id: R1,
      orgId: ORG,
      siteId: SITE,
      name: 'Boardroom',
      type: 'meeting',
      kind: 'standard',
      gatewayId: G1,
      areaId: CHILD,
      tags: ['VIP'],
      updatedAt: NOW,
    },
    {
      id: R2,
      orgId: ORG,
      siteId: SITE,
      name: 'Studio',
      type: 'training',
      kind: 'standard',
      gatewayId: G2,
      areaId: null,
      tags: [],
      updatedAt: NOW,
    },
    {
      id: R3,
      orgId: ORG,
      siteId: SITE2,
      name: 'Foyer',
      type: 'meeting',
      kind: 'standard',
      gatewayId: null,
      areaId: null,
      tags: [],
      updatedAt: NOW,
    },
  ]);
  const gateway = table([
    {
      id: G1,
      orgId: ORG,
      siteId: SITE,
      name: 'GW1',
      enrolledAt: old,
      lastSeenAt: recent,
      createdAt: old,
    },
    {
      id: G2,
      orgId: ORG,
      siteId: SITE,
      name: 'GW2',
      enrolledAt: old,
      lastSeenAt: old,
      createdAt: old,
    },
  ]);
  const site = table([
    { id: SITE, orgId: ORG, name: 'HQ' },
    { id: SITE2, orgId: ORG, name: 'Annex' },
  ]);
  const area = table([
    {
      id: AREA,
      orgId: ORG,
      siteId: SITE,
      parentId: null,
      name: 'Building A',
      label: 'Building',
      sortOrder: 0,
    },
    {
      id: CHILD,
      orgId: ORG,
      siteId: SITE,
      parentId: AREA,
      name: 'Level 2',
      label: 'Level',
      sortOrder: 0,
    },
  ]);
  const dev = (id: string, roomId: string, over: Record<string, unknown> = {}) => ({
    id,
    orgId: ORG,
    siteId: SITE,
    roomId,
    kind: 'active',
    gatewayId: null,
    online: true,
    ...over,
  });
  const device = table([
    dev('d1', R1),
    dev('d2', R1, { online: false }),
    dev('d3', R1, { kind: 'passive', online: null }),
    // In a room whose gateway is offline: unknown, not offline.
    dev('d4', R2),
    // A device on its own online gateway even though its room gateway is offline.
    dev('d5', R2, { gatewayId: G1 }),
    // Only a passive asset: nothing to monitor.
    dev('d6', R3, { siteId: SITE2, kind: 'passive', online: null }),
  ]);
  const deviceStatus = table([]);
  const incident = table([
    { id: 'i1', orgId: ORG, roomId: R1, gatewayId: G1, status: 'open', severity: 'warning' },
    { id: 'i2', orgId: ORG, roomId: null, gatewayId: G2, status: 'open', severity: 'critical' },
  ]);
  const ticket = table([
    { id: 't1', orgId: ORG, roomId: R1, status: 'open' },
    { id: 't2', orgId: ORG, roomId: R2, status: 'in_progress' },
  ]);
  const db = {
    room,
    gateway,
    site,
    area,
    device,
    deviceStatus,
    incident,
    ticket,
  } as unknown as EstateDb;
  return { db, deviceStatus };
}

describe('estateOverview', () => {
  it('counts active, passive, online, offline and unknown devices per room', async () => {
    const { db } = world();
    const o = await estateOverview(db, ORG, NOW);
    const r1 = o.rooms.find((r) => r.id === R1)!;
    expect(r1.devices).toEqual({ active: 2, online: 1, offline: 1, unknown: 0, passive: 1 });
    expect(r1.areaPath).toBe('Building A / Level 2');
    expect(r1.tags).toEqual(['VIP']);
    expect(r1.health.level).toBe('degraded');
    expect(r1.openIncidents).toBe(1);
  });

  it('shows unknown (not offline) for devices behind a silent gateway, and the worst gateway state', async () => {
    const { db } = world();
    const r2 = (await estateOverview(db, ORG, NOW)).rooms.find((r) => r.id === R2)!;
    expect(r2.devices).toMatchObject({ active: 2, online: 1, unknown: 1, offline: 0 });
    expect(r2.gatewayStatus).toBe('offline');
    expect(r2.gateways.map((g) => g.id).sort()).toEqual([G1, G2].sort());
    expect(r2.health.level).toBe('unknown');
  });

  it('marks a room with only passive assets as not monitored', async () => {
    const { db } = world();
    const r3 = (await estateOverview(db, ORG, NOW)).rooms.find((r) => r.id === R3)!;
    expect(r3.devices).toMatchObject({ active: 0, passive: 1 });
    expect(r3.health).toEqual({
      level: 'unknown',
      reasons: ['Only recorded assets, nothing is monitored'],
    });
  });

  it('rolls up the KPI cards', async () => {
    const { db } = world();
    const { kpis } = await estateOverview(db, ORG, NOW);
    expect(kpis).toMatchObject({
      liveIncidents: 2,
      criticalIncidents: 1,
      roomsNeedingAttention: 1,
      rooms: 3,
      roomsMonitored: 2,
      devicesActive: 4,
      devicesOnline: 2,
      devicesUnknown: 1,
      devicesPassive: 2,
      gateways: 2,
      gatewaysOnline: 1,
      openTickets: 2,
      roomsInUse: null,
      driftCount: null,
    });
  });

  it('counts older room-design devices as active devices', async () => {
    const { db, deviceStatus } = world();
    await deviceStatus.create({
      data: { orgId: ORG, roomId: R1, deviceId: 'x', name: 'Old', online: false },
    });
    const r1 = (await estateOverview(db, ORG, NOW)).rooms.find((r) => r.id === R1)!;
    expect(r1.devices).toMatchObject({ active: 3, offline: 2 });
  });

  it('limits a site-limited provider to its own sites', async () => {
    const { db } = world();
    const o = await estateOverview(db, ORG, NOW, [SITE2]);
    expect(o.rooms.map((r) => r.id)).toEqual([R3]);
    expect(o.sites.map((s) => s.id)).toEqual([SITE2]);
    expect(o.areas).toEqual([]);
    expect(o.kpis).toMatchObject({ rooms: 1, gateways: 0, liveIncidents: 0, openTickets: 0 });
  });
});
