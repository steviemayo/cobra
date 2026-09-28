import { describe, expect, it } from 'vitest';
import { RoomModel } from '@kestrel/model';
import {
  orgDevices,
  orgOverview,
  sharedInRoom,
  type DevicesDb,
  type OverviewDb,
  type SharedDb,
} from './monitoring-queries';
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
  const roomDraft = table([]);
  const siteDevice = table([]);
  return {
    room,
    gateway,
    site,
    deviceStatus,
    incident,
    roomDraft,
    siteDevice,
  } as unknown as OverviewDb & DevicesDb & SharedDb;
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

describe('the device list', () => {
  const SHARED = '22222222-2222-4222-8222-222222222222';
  const control = { kind: 'generic', protocol: 'tcp' };
  const usesShared = (deviceId: string) =>
    RoomModel.parse({
      roomType: 'meeting',
      devices: [
        { id: deviceId, name: 'DSP', category: 'audio_matrix', control, siteDeviceId: SHARED },
      ],
    });
  /** Two rooms at Head office sharing one DSP, each with its own status row for it. */
  function sharedWorld(dsp: [boolean, boolean] = [true, true]) {
    const db = world();
    const rooms = (db as unknown as { room: { rows: Record<string, unknown>[] } }).room.rows;
    rooms.push({ id: 'r3', orgId: ORG, name: 'Training', siteId: 's1', gatewayId: 'g1' });
    const t = db as unknown as Record<string, { rows: Record<string, unknown>[] }>;
    t.deviceStatus!.rows.push(
      {
        id: 'd10',
        orgId: ORG,
        roomId: 'r1',
        deviceId: 'dsp',
        name: 'DSP',
        online: dsp[0],
        since: NOW,
      },
      {
        id: 'd11',
        orgId: ORG,
        roomId: 'r3',
        deviceId: 'dsp-t',
        name: 'DSP',
        online: dsp[1],
        since: NOW,
      },
    );
    t.roomDraft!.rows.push(
      { id: 'x1', orgId: ORG, roomId: 'r1', model: usesShared('dsp') },
      { id: 'x2', orgId: ORG, roomId: 'r3', model: usesShared('dsp-t') },
    );
    t.siteDevice!.rows.push({ id: SHARED, orgId: ORG, siteId: 's1', name: 'Core DSP' });
    return db;
  }

  it('joins every device with its room and site', async () => {
    const d = await orgDevices(world(), ORG);
    expect(d).toHaveLength(2);
    expect(d.find((x) => x.name === 'Projector')).toMatchObject({
      online: true,
      rooms: [{ id: 'r1', name: 'Boardroom' }],
      siteName: 'Head office',
      shared: false,
    });
    expect(d.find((x) => x.name === 'Mic')).toMatchObject({
      online: false,
      rooms: [{ id: 'r2', name: 'Dock office' }],
      siteName: 'Warehouse',
    });
  });

  it('lists a shared device once, with every room that uses it', async () => {
    const d = await orgDevices(sharedWorld(), ORG);
    const dsp = d.filter((x) => x.shared);
    expect(dsp).toHaveLength(1);
    expect(dsp[0]).toMatchObject({ name: 'Core DSP', online: true });
    expect(dsp[0]!.rooms.map((r) => r.name).sort()).toEqual(['Boardroom', 'Training']);
    expect(d).toHaveLength(3);
  });

  it('says a shared device is offline if any room reports it offline', async () => {
    const d = await orgDevices(sharedWorld([true, false]), ORG);
    expect(d.find((x) => x.shared)).toMatchObject({ online: false });
  });

  it('a site-limited provider sees only its site’s devices and rooms', async () => {
    const d = await orgDevices(sharedWorld(), ORG, ['s1']);
    expect(d.map((x) => x.name).sort()).toEqual(['Core DSP', 'Projector']);
    const none = await orgDevices(sharedWorld(), ORG, ['s2']);
    expect(none.map((x) => x.name)).toEqual(['Mic']);
  });

  it('falls back to one row per room when a design cannot be read', async () => {
    const db = sharedWorld();
    (db as unknown as Record<string, { rows: Record<string, unknown>[] }>).roomDraft!.rows.length =
      0;
    const d = await orgDevices(db, ORG);
    expect(d.filter((x) => x.name === 'DSP')).toHaveLength(2);
  });

  it('a scope with no sites sees no devices', async () => {
    expect(await orgDevices(world(), ORG, [])).toEqual([]);
  });

  it('tells a room which other rooms share each of its devices', async () => {
    const shared = await sharedInRoom(sharedWorld(), ORG, { id: 'r1', siteId: 's1' });
    expect(shared).toEqual({
      dsp: { name: 'Core DSP', otherRooms: [{ id: 'r3', name: 'Training' }] },
    });
    expect(await sharedInRoom(sharedWorld(), ORG, { id: 'r2', siteId: 's2' })).toEqual({});
  });
});
