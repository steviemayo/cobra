import { describe, expect, it } from 'vitest';
import { orgDevices, orgOverview, type OverviewDb } from './monitoring-queries';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-26T00:00:00Z');

function world() {
  const site = table([
    { id: 's1', orgId: ORG, name: 'Head office' },
    { id: 's2', orgId: ORG, name: 'Warehouse' },
  ]);
  const room = table([
    {
      id: 'r1',
      orgId: ORG,
      name: 'Boardroom',
      type: 'meeting',
      siteId: 's1',
      gatewayId: 'g1',
      reportedStatus: 'on',
      reportedReleaseId: 'rel',
    },
    {
      id: 'r2',
      orgId: ORG,
      name: 'Dock office',
      type: 'meeting',
      siteId: 's2',
      gatewayId: 'g2',
      reportedStatus: 'off',
      reportedReleaseId: 'rel',
    },
  ]);
  const gateway = table([
    { id: 'g1', orgId: ORG, name: 'Gateway HO', siteId: 's1', enrolledAt: NOW, lastSeenAt: NOW },
    {
      id: 'g2',
      orgId: ORG,
      name: 'Gateway WH',
      siteId: 's2',
      enrolledAt: NOW,
      lastSeenAt: new Date(NOW.getTime() - 3_600_000),
    },
  ]);
  const deviceStatus = table([
    {
      id: 'd1',
      orgId: ORG,
      roomId: 'r1',
      deviceId: 'projector',
      name: 'Projector',
      online: true,
      since: NOW,
    },
    { id: 'd2', orgId: ORG, roomId: 'r2', deviceId: 'mic', name: 'Mic', online: false, since: NOW },
  ]);
  const incident = table([
    { id: 'i1', orgId: ORG, status: 'open', roomId: 'r1', gatewayId: 'g1', severity: 'warning' },
    { id: 'i2', orgId: ORG, status: 'open', roomId: 'r2', gatewayId: 'g2', severity: 'critical' },
    { id: 'i3', orgId: ORG, status: 'open', roomId: null, gatewayId: 'g2', severity: 'critical' },
  ]);
  return { room, gateway, site, deviceStatus, incident } as unknown as OverviewDb;
}

describe('the live overview', () => {
  it('covers the whole organisation with no scope', async () => {
    const o = await orgOverview(world(), ORG, NOW);
    expect(o.rooms.map((r) => r.name).sort()).toEqual(['Boardroom', 'Dock office']);
    expect(o.gateways).toHaveLength(2);
    expect(o.incidents).toEqual({ open: 3, critical: 2 });
  });

  it('a site-limited provider sees only its sites: rooms, gateways and incidents', async () => {
    const o = await orgOverview(world(), ORG, NOW, ['s1']);
    expect(o.rooms.map((r) => r.name)).toEqual(['Boardroom']);
    expect(o.gateways.map((g) => g.name)).toEqual(['Gateway HO']);
    expect(o.incidents).toEqual({ open: 1, critical: 0 });
  });

  it('does not leak the other site’s gateway incident or device counts', async () => {
    const o = await orgOverview(world(), ORG, NOW, ['s2']);
    expect(o.rooms).toHaveLength(1);
    expect(o.rooms[0]).toMatchObject({
      name: 'Dock office',
      siteName: 'Warehouse',
      openIncidents: 1,
    });
    expect(o.rooms[0]!.devices).toEqual({ total: 1, online: 0 });
    // The room incident and the silent-gateway incident are both about this site.
    expect(o.incidents.open).toBe(2);
    expect(o.gateways[0]).toMatchObject({
      name: 'Gateway WH',
      status: 'offline',
      openIncidents: 1,
    });
  });

  it('a scope with no sites sees nothing', async () => {
    const o = await orgOverview(world(), ORG, NOW, []);
    expect(o.rooms).toEqual([]);
    expect(o.gateways).toEqual([]);
    expect(o.incidents).toEqual({ open: 0, critical: 0 });
  });
});

describe('the flat device list', () => {
  it('joins every device with its room and site', async () => {
    const d = await orgDevices(world(), ORG);
    expect(d).toHaveLength(2);
    expect(d.find((x) => x.deviceId === 'projector')).toMatchObject({
      name: 'Projector',
      online: true,
      roomName: 'Boardroom',
      siteName: 'Head office',
    });
    expect(d.find((x) => x.deviceId === 'mic')).toMatchObject({
      name: 'Mic',
      online: false,
      roomName: 'Dock office',
      siteName: 'Warehouse',
    });
  });

  it('a site-limited provider sees only its site’s devices', async () => {
    const d = await orgDevices(world(), ORG, ['s1']);
    expect(d.map((x) => x.deviceId)).toEqual(['projector']);
  });

  it('a scope with no sites sees no devices', async () => {
    expect(await orgDevices(world(), ORG, [])).toEqual([]);
  });
});
