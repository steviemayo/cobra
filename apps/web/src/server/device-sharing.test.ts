import { beforeAll, describe, expect, it } from 'vitest';
import { generateSealKey } from '@kestrel/crypto';
import type { ControlPoint, DeviceReport } from '@kestrel/model';
import { createDevice, recordDeviceReports, type DevicesDb } from './devices';
import { deviceViews, type DeviceViewsDb } from './device-views';
import { pointsForRoom, roomsServedBy, setDeviceRooms, type SharingDb } from './device-sharing';
import { setDevicePoints, type PointsDb } from './device-points';
import { DEVICE_GRACE_MS } from './monitoring';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '11111111-1111-4111-8111-111111111112';
const SITE_A = '22222222-2222-4222-8222-222222222221';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const ROOM_A = '33333333-3333-4333-8333-333333333331';
const ROOM_B = '33333333-3333-4333-8333-333333333332';
const ROOM_C = '33333333-3333-4333-8333-333333333333';
const FOREIGN = '33333333-3333-4333-8333-333333333339';
const GW = '99999999-9999-4999-8999-999999999991';
const T0 = new Date('2026-09-30T10:00:00Z');

beforeAll(() => {
  process.env.KESTREL_SECRETS_KEY = generateSealKey();
});

function world() {
  const device = table([]);
  const deviceRoom = table([]);
  const incident = table([]);
  const room = table([
    { id: ROOM_A, orgId: ORG, siteId: SITE_A, name: 'Room A', gatewayId: GW },
    { id: ROOM_B, orgId: ORG, siteId: SITE_B, name: 'Room B', gatewayId: null },
    { id: ROOM_C, orgId: ORG, siteId: SITE_A, name: 'Room C', gatewayId: null },
    { id: FOREIGN, orgId: OTHER_ORG, siteId: SITE_A, name: 'Elsewhere', gatewayId: null },
  ]);
  const db = {
    device,
    deviceRoom,
    deviceEvent: table([]),
    deviceHistory: table([]),
    room,
    gateway: table([{ id: GW, orgId: ORG, siteId: SITE_A, createdAt: T0 }]),
    incident,
    credentialSet: table([]),
    area: table([]),
    site: table([
      { id: SITE_A, orgId: ORG },
      { id: SITE_B, orgId: ORG },
    ]),
  };
  return { ...db, db: db as unknown as DevicesDb & SharingDb & PointsDb & DeviceViewsDb };
}

const point = (id: string, roomId?: string): ControlPoint => ({
  id,
  name: id,
  type: 'level',
  address: { component: id, control: 'gain' },
  ...(roomId ? { roomId } : {}),
});

async function dsp(w: ReturnType<typeof world>) {
  const res = await createDevice(w.db, {
    orgId: ORG,
    siteId: SITE_A,
    roomId: ROOM_A,
    kind: 'active',
    name: 'DSP',
    category: 'audio_matrix',
    control: { kind: 'driver', driverId: 'qsys-core' },
    values: { host: '10.0.0.5' },
    actorId: null,
  });
  if (!res.ok) throw new Error(res.message);
  return res.value.id;
}

const report = (deviceId: string, over: Partial<DeviceReport> = {}): DeviceReport => ({
  deviceId,
  name: 'DSP',
  online: true,
  ...over,
});

describe('sharing a device between rooms', () => {
  it('serves other rooms, in other sites too, and lists them with the home room first', async () => {
    const w = world();
    const id = await dsp(w);
    const res = await setDeviceRooms(w.db, { orgId: ORG, deviceId: id, roomIds: [ROOM_B, ROOM_C], actorId: null });
    expect(res).toEqual({ ok: true, rooms: 2 });
    expect(w.deviceRoom.rows).toHaveLength(2);
    expect(await roomsServedBy(w.db, { id, orgId: ORG, roomId: ROOM_A })).toEqual([ROOM_A, ROOM_B, ROOM_C]);
    expect(w.device.rows[0]!.version).toBe(2);
  });

  it('ignores the home room in the list, and changes nothing when nothing changed', async () => {
    const w = world();
    const id = await dsp(w);
    await setDeviceRooms(w.db, { orgId: ORG, deviceId: id, roomIds: [ROOM_A, ROOM_B], actorId: null });
    const version = w.device.rows[0]!.version;
    await setDeviceRooms(w.db, { orgId: ORG, deviceId: id, roomIds: [ROOM_B], actorId: null });
    expect(w.deviceRoom.rows).toHaveLength(1);
    expect(w.device.rows[0]!.version).toBe(version);
  });

  it('refuses a room from another organisation and a device that is not there', async () => {
    const w = world();
    const id = await dsp(w);
    expect(await setDeviceRooms(w.db, { orgId: ORG, deviceId: id, roomIds: [FOREIGN], actorId: null })).toMatchObject({ ok: false });
    expect(await setDeviceRooms(w.db, { orgId: ORG, deviceId: 'nope', roomIds: [], actorId: null })).toMatchObject({ ok: false });
  });

  it('takes off the control points of a room that is no longer served', async () => {
    const w = world();
    const id = await dsp(w);
    await setDeviceRooms(w.db, { orgId: ORG, deviceId: id, roomIds: [ROOM_B, ROOM_C], actorId: null });
    const set = await setDevicePoints(w.db, {
      orgId: ORG,
      deviceId: id,
      actorId: null,
      points: [point('a', ROOM_A), point('b', ROOM_B), point('c', ROOM_C), point('whole')],
    });
    expect(set).toEqual({ ok: true });
    await setDeviceRooms(w.db, { orgId: ORG, deviceId: id, roomIds: [ROOM_B], actorId: null });
    expect((w.device.rows[0]!.points as ControlPoint[]).map((p) => p.id)).toEqual(['a', 'b', 'whole']);
  });

  it('only lets a point belong to a room the device serves', async () => {
    const w = world();
    const id = await dsp(w);
    const res = await setDevicePoints(w.db, { orgId: ORG, deviceId: id, actorId: null, points: [point('x', ROOM_B)] });
    expect(res).toMatchObject({ ok: false });
  });

  it('shows each room its own points and the ones that belong to the whole device', () => {
    const all = [point('a', ROOM_A), point('b', ROOM_B), point('whole')];
    expect(pointsForRoom(all, ROOM_B).map((p) => p.id)).toEqual(['b', 'whole']);
    expect(pointsForRoom(all, undefined)).toHaveLength(3);
  });
});

describe('a shared device in the room views', () => {
  it('appears in every room it serves, with its other rooms named and only that room’s points', async () => {
    const w = world();
    const id = await dsp(w);
    await setDeviceRooms(w.db, { orgId: ORG, deviceId: id, roomIds: [ROOM_B], actorId: null });
    await setDevicePoints(w.db, {
      orgId: ORG,
      deviceId: id,
      actorId: null,
      points: [point('a', ROOM_A), point('b', ROOM_B)],
    });
    const inB = await deviceViews(w.db, { orgId: ORG, roomId: ROOM_B });
    expect(inB.map((d) => d.id)).toEqual([id]);
    expect(inB[0]!.sharedRooms).toEqual([{ id: ROOM_B, name: 'Room B', siteId: SITE_B }]);
    expect((inB[0]!.points as ControlPoint[]).map((p) => p.id)).toEqual(['b']);
    const inC = await deviceViews(w.db, { orgId: ORG, roomId: ROOM_C });
    expect(inC).toEqual([]);
  });
});

describe('one incident for a shared device', () => {
  it('lists every room it affects, and names them', async () => {
    const w = world();
    const id = await dsp(w);
    await setDeviceRooms(w.db, { orgId: ORG, deviceId: id, roomIds: [ROOM_B, ROOM_C], actorId: null });
    const gw = { id: GW, orgId: ORG, siteId: SITE_A };
    await recordDeviceReports(w.db, gw, [report(id, { online: false })], T0);
    await recordDeviceReports(w.db, gw, [report(id, { online: false })], new Date(T0.getTime() + DEVICE_GRACE_MS + 1000));
    expect(w.incident.rows).toHaveLength(1);
    const inc = w.incident.rows[0]!;
    expect(inc).toMatchObject({ kind: 'device_offline', roomId: ROOM_A });
    expect(inc.roomIds).toEqual([ROOM_B, ROOM_C]);
    expect(String(inc.detail)).toContain('affects Room A, Room B, Room C');
  });

  it('is an ordinary one-room incident for a device that is not shared', async () => {
    const w = world();
    const id = await dsp(w);
    const gw = { id: GW, orgId: ORG, siteId: SITE_A };
    await recordDeviceReports(w.db, gw, [report(id, { online: false })], T0);
    await recordDeviceReports(w.db, gw, [report(id, { online: false })], new Date(T0.getTime() + DEVICE_GRACE_MS + 1000));
    expect(w.incident.rows[0]!.roomIds).toEqual([]);
    expect(String(w.incident.rows[0]!.detail)).toContain('in Room A');
  });
});
