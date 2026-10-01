import { beforeAll, describe, expect, it } from 'vitest';
import { generateSealKey, generateKeyPair, verifyDeviceSet } from '@kestrel/crypto';
import type { DeviceReport } from '@kestrel/model';
import {
  createArea,
  createDevice,
  deviceSetVersion,
  devicesForGateway,
  gatewayIdFor,
  recordDeviceReports,
  resolveSwap,
  signedDeviceSetFor,
  updateArea,
  updateDevice,
  type DevicesDb,
} from './devices';
import { DEVICE_GRACE_MS } from './monitoring';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const ROOM = '33333333-3333-4333-8333-333333333331';
const GW_ROOM = '99999999-9999-4999-8999-999999999991';
const GW_OTHER = '99999999-9999-4999-8999-999999999992';
const T0 = new Date('2026-09-30T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function world() {
  const device = table([]);
  const deviceEvent = table([]);
  const deviceHistory = table([]);
  const room = table([
    { id: ROOM, orgId: ORG, siteId: SITE, name: 'Boardroom', gatewayId: GW_ROOM },
  ]);
  const gateway = table([
    { id: GW_ROOM, orgId: ORG, siteId: SITE, createdAt: at(-2000) },
    { id: GW_OTHER, orgId: ORG, siteId: SITE, createdAt: at(-1000) },
  ]);
  const incident = table([]);
  const credentialSet = table([]);
  const area = table([]);
  const site = table([{ id: SITE, orgId: ORG }]);
  const db = {
    device,
    deviceEvent,
    deviceHistory,
    room,
    gateway,
    incident,
    credentialSet,
    area,
    site,
  } as unknown as DevicesDb;
  return { db, device, deviceEvent, deviceHistory, room, gateway, incident, area, site };
}

const gw = { id: GW_ROOM, orgId: ORG, siteId: SITE };
const report = (deviceId: string, over: Partial<DeviceReport> = {}): DeviceReport => ({
  deviceId,
  name: 'Display',
  online: true,
  ...over,
});
const details = (serial: string) => [
  {
    title: 'Device',
    rows: [
      { label: 'Serial number', value: serial },
      { label: 'Model', value: 'X-1' },
    ],
  },
];

beforeAll(() => {
  process.env.KESTREL_SECRETS_KEY = generateSealKey();
});

async function activeDevice(w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) {
  const res = await createDevice(w.db, {
    orgId: ORG,
    siteId: SITE,
    roomId: ROOM,
    kind: 'active',
    name: 'Display',
    category: 'display',
    control: { kind: 'generic', protocol: 'pjlink' },
    values: { host: '10.0.0.5' },
    actorId: null,
    ...extra,
  });
  if (!res.ok) throw new Error(res.message);
  return res.value.id;
}

describe('creating devices', () => {
  it('makes a passive asset with manual fields and a created event', async () => {
    const w = world();
    const res = await createDevice(w.db, {
      orgId: ORG,
      siteId: SITE,
      roomId: ROOM,
      kind: 'passive',
      name: 'Laptop',
      category: 'computer',
      serial: 'LT-1',
      actorId: null,
    });
    expect(res.ok).toBe(true);
    const row = w.device.rows[0]!;
    expect(row).toMatchObject({ kind: 'passive', serial: 'LT-1', gatewayId: null });
    expect((row.provenance as Record<string, { source: string }>).serial?.source).toBe('manual');
    expect(w.deviceEvent.rows.map((e) => e.type)).toEqual(['created']);
  });

  it('refuses an active device with no driver, and a gateway from another site', async () => {
    const w = world();
    const base = {
      orgId: ORG,
      siteId: SITE,
      kind: 'active' as const,
      name: 'D',
      category: 'display',
      actorId: null,
    };
    expect((await createDevice(w.db, base)).ok).toBe(false);
    const bad = await createDevice(w.db, {
      ...base,
      control: { kind: 'generic', protocol: 'pjlink' },
      gatewayId: '99999999-9999-4999-8999-999999999999',
    });
    expect(bad).toMatchObject({ ok: false, message: 'That gateway is not in this site' });
  });

  it('seals logins so they are not stored in the clear', async () => {
    const w = world();
    await activeDevice(w, { secrets: { password: 'hunter2' } });
    const sealed = String(w.device.rows[0]!.sealed);
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain('hunter2');
  });
});

describe('which gateway polls a device', () => {
  it('uses the device gateway, then the room, then the site', async () => {
    const w = world();
    const own = await activeDevice(w, { gatewayId: GW_OTHER });
    const inRoom = await activeDevice(w, { name: 'Camera' });
    const spare = await activeDevice(w, { name: 'Spare', roomId: null });
    const rows = (id: string) => w.device.rows.find((r) => r.id === id) as never;
    expect(await gatewayIdFor(w.db, rows(own))).toBe(GW_OTHER);
    expect(await gatewayIdFor(w.db, rows(inRoom))).toBe(GW_ROOM);
    // No room, no override: the site's oldest gateway.
    expect(await gatewayIdFor(w.db, rows(spare))).toBe(GW_ROOM);
    const forRoomGw = await devicesForGateway(w.db, gw);
    expect(forRoomGw.map((d) => d.id).sort()).toEqual([inRoom, spare].sort());
    const forOther = await devicesForGateway(w.db, { id: GW_OTHER, orgId: ORG, siteId: SITE });
    expect(forOther.map((d) => d.id)).toEqual([own]);
  });
});

describe('the site default gateway', () => {
  it('uses the gateway the site names, and falls back to the oldest when none is named', async () => {
    const w = world();
    const spare = await activeDevice(w, { name: 'Spare', roomId: null });
    const row = () => w.device.rows.find((r) => r.id === spare) as never;
    expect(await gatewayIdFor(w.db, row())).toBe(GW_ROOM);
    (w.site.rows[0] as Record<string, unknown>).defaultGatewayId = GW_OTHER;
    expect(await gatewayIdFor(w.db, row())).toBe(GW_OTHER);
    // A named gateway that no longer exists at the site is ignored.
    (w.site.rows[0] as Record<string, unknown>).defaultGatewayId =
      '99999999-9999-4999-8999-999999999999';
    expect(await gatewayIdFor(w.db, row())).toBe(GW_ROOM);
  });
});

describe('the signed device set', () => {
  it('merges address and login, signs, and changes version when a device changes', async () => {
    const w = world();
    const id = await activeDevice(w, { secrets: { password: 'pw' } });
    const { publicKeyPem, privateKeyPem } = generateKeyPair();
    const key = { privateKeyPem, publicKeyPem, keyId: 'k1' };
    const signed = await signedDeviceSetFor(w.db, gw, key);
    expect(verifyDeviceSet(signed, [{ keyId: 'k1', publicKeyPem }]).ok).toBe(true);
    expect(signed.payload.devices[0]).toMatchObject({
      id,
      settings: { host: '10.0.0.5', password: 'pw' },
    });
    const before = await deviceSetVersion(w.db, gw);
    expect(before).toBe(signed.payload.version);
    await updateDevice(w.db, {
      orgId: ORG,
      deviceId: id,
      actorId: null,
      patch: { values: { host: '10.0.0.6' } },
    });
    expect(await deviceSetVersion(w.db, gw)).not.toBe(before);
  });

  it('is refused when tampered with', async () => {
    const w = world();
    await activeDevice(w);
    const { publicKeyPem, privateKeyPem } = generateKeyPair();
    const signed = await signedDeviceSetFor(w.db, gw, { privateKeyPem, publicKeyPem, keyId: 'k1' });
    const forged = structuredClone(signed);
    forged.payload.devices[0]!.settings = { host: '6.6.6.6' };
    expect(verifyDeviceSet(forged, [{ keyId: 'k1', publicKeyPem }])).toMatchObject({
      ok: false,
      reason: 'hash_mismatch',
    });
  });
});

describe('reading history', () => {
  it('records online and feedback changes once, not on every heartbeat', async () => {
    const w = world();
    const id = await activeDevice(w);
    await recordDeviceReports(
      w.db,
      gw,
      [report(id, { feedback: { power: 'on', volume: 40 } })],
      T0,
    );
    await recordDeviceReports(
      w.db,
      gw,
      [report(id, { feedback: { power: 'on', volume: 40 } })],
      at(30_000),
    );
    await recordDeviceReports(
      w.db,
      gw,
      [report(id, { feedback: { power: 'off', volume: 40 } })],
      at(60_000),
    );
    const rows = w.deviceHistory.rows.map((r) => `${r.field}=${r.value}`);
    expect(rows).toEqual(['online=true', 'power=on', 'volume=40', 'power=off']);
    await recordDeviceReports(w.db, gw, [report(id, { online: false })], at(90_000));
    expect(w.deviceHistory.rows.at(-1)).toMatchObject({ field: 'online', value: 'false' });
  });
});

describe('heartbeat reports', () => {
  it('records state and fills the asset record from what the device says', async () => {
    const w = world();
    const id = await activeDevice(w);
    await recordDeviceReports(
      w.db,
      gw,
      [report(id, { firmware: '1.0', details: details('SN1') })],
      T0,
    );
    const row = w.device.rows[0]!;
    expect(row).toMatchObject({
      online: true,
      serial: 'SN1',
      model: 'X-1',
      firmware: '1.0',
      ip: '10.0.0.5',
      swapPending: false,
    });
    expect((row.provenance as Record<string, { source: string }>).serial?.source).toBe(
      'discovered',
    );
  });

  it('flags a changed serial as a possible swap and records it in the history', async () => {
    const w = world();
    const id = await activeDevice(w);
    await recordDeviceReports(w.db, gw, [report(id, { details: details('SN1') })], T0);
    await recordDeviceReports(w.db, gw, [report(id, { details: details('SN2') })], at(60_000));
    expect(w.device.rows[0]).toMatchObject({ serial: 'SN2', swapPending: true });
    const types = w.deviceEvent.rows.map((e) => e.type);
    expect(types).toContain('swap_flagged');
    const flagged = w.deviceEvent.rows.find((e) => e.type === 'swap_flagged')!;
    expect(flagged).toMatchObject({ field: 'serial', oldValue: 'SN1', newValue: 'SN2' });
  });

  it('keeps a typed serial and shows the difference instead of overwriting it', async () => {
    const w = world();
    const id = await activeDevice(w);
    await updateDevice(w.db, {
      orgId: ORG,
      deviceId: id,
      actorId: null,
      patch: { serial: 'TYPED' },
    });
    await recordDeviceReports(w.db, gw, [report(id, { details: details('REAL') })], T0);
    const row = w.device.rows[0]!;
    expect(row.serial).toBe('TYPED');
    expect((row.provenance as Record<string, { discovered?: string }>).serial?.discovered).toBe(
      'REAL',
    );
    expect(row.swapPending).toBe(false);
  });

  it('ignores a device this gateway does not poll', async () => {
    const w = world();
    const id = await activeDevice(w, { gatewayId: GW_OTHER });
    await recordDeviceReports(w.db, gw, [report(id)], T0);
    expect(w.device.rows[0]!.online).toBeUndefined();
  });

  it('opens an incident after the grace period and resolves it when the device answers', async () => {
    const w = world();
    const id = await activeDevice(w);
    await recordDeviceReports(w.db, gw, [report(id, { online: false })], T0);
    expect(w.incident.rows).toHaveLength(0);
    const jobs = await recordDeviceReports(
      w.db,
      gw,
      [report(id, { online: false })],
      at(DEVICE_GRACE_MS + 1000),
    );
    expect(w.incident.rows).toHaveLength(1);
    expect(w.incident.rows[0]).toMatchObject({
      kind: 'device_offline',
      subject: `device:${id}`,
      status: 'open',
    });
    expect(jobs).toHaveLength(1);
    // The time in the incident reads as the site keeps it (Sydney here: 10:00 UTC is 8:00 pm AEST),
    // with the zone named, not as a UTC string.
    expect(String(w.incident.rows[0]!.detail)).toContain('since 30 Sept 2026, 8:00 pm AEST');
    expect(String(w.incident.rows[0]!.detail)).not.toContain('T10:00');
    await recordDeviceReports(
      w.db,
      gw,
      [report(id, { online: true })],
      at(DEVICE_GRACE_MS + 60_000),
    );
    expect(w.incident.rows[0]!.status).toBe('resolved');
  });
});

describe('editing and swaps', () => {
  it('records manual edits and moves, and bumps the version only when a gateway needs to know', async () => {
    const w = world();
    const id = await activeDevice(w);
    await updateDevice(w.db, {
      orgId: ORG,
      deviceId: id,
      actorId: 'u1',
      patch: { supplier: 'Acme', roomId: null },
    });
    expect(w.device.rows[0]).toMatchObject({ supplier: 'Acme', roomId: null, version: 1 });
    expect(w.deviceEvent.rows.map((e) => e.type)).toEqual(
      expect.arrayContaining(['field_changed', 'moved']),
    );
    await updateDevice(w.db, {
      orgId: ORG,
      deviceId: id,
      actorId: 'u1',
      patch: { gatewayId: GW_OTHER },
    });
    expect(w.device.rows[0]!.version).toBe(2);
  });

  it('upgrades a passive device to active when a driver is added', async () => {
    const w = world();
    const res = await createDevice(w.db, {
      orgId: ORG,
      siteId: SITE,
      kind: 'passive',
      name: 'Cam',
      category: 'fixed_camera',
      actorId: null,
    });
    if (!res.ok) throw new Error(res.message);
    await updateDevice(w.db, {
      orgId: ORG,
      deviceId: res.value.id,
      actorId: null,
      patch: { control: { kind: 'generic', protocol: 'tcp' } },
    });
    expect(w.device.rows[0]).toMatchObject({ kind: 'active' });
    expect(w.deviceEvent.rows.map((e) => e.type)).toContain('upgraded');
  });

  it('retires the old identity when a swap is confirmed, and drops the notice on a correction', async () => {
    const w = world();
    const id = await activeDevice(w);
    await recordDeviceReports(w.db, gw, [report(id, { details: details('SN1') })], T0);
    await recordDeviceReports(w.db, gw, [report(id, { details: details('SN2') })], at(60_000));
    const res = await resolveSwap(w.db, {
      orgId: ORG,
      deviceId: id,
      outcome: 'replaced',
      actorId: 'u1',
    });
    expect(res.ok).toBe(true);
    const row = w.device.rows[0]!;
    expect(row.swapPending).toBe(false);
    expect((row.retiredIdentities as { fields: Record<string, string> }[])[0]!.fields.serial).toBe(
      'SN1',
    );
    expect(w.deviceEvent.rows.map((e) => e.type)).toContain('swap_confirmed');
    expect(
      (await resolveSwap(w.db, { orgId: ORG, deviceId: id, outcome: 'correction', actorId: 'u1' }))
        .ok,
    ).toBe(false);
  });

  it('does not touch a device from another organisation', async () => {
    const w = world();
    const id = await activeDevice(w);
    const res = await updateDevice(w.db, {
      orgId: '44444444-4444-4444-8444-444444444444',
      deviceId: id,
      actorId: null,
      patch: { name: 'X' },
    });
    expect(res).toMatchObject({ ok: false, message: 'No such device' });
  });
});

describe('areas', () => {
  it('nests three deep and no further, and refuses loops', async () => {
    const w = world();
    const make = async (name: string, parentId: string | null) => {
      const r = await createArea(w.db, { orgId: ORG, siteId: SITE, parentId, name });
      if (!r.ok) throw new Error(r.message);
      return r.value.id;
    };
    const building = await make('Building A', null);
    const level = await make('Level 2', building);
    const wing = await make('East wing', level);
    const tooDeep = await createArea(w.db, {
      orgId: ORG,
      siteId: SITE,
      parentId: wing,
      name: 'Too deep',
    });
    expect(tooDeep.ok).toBe(false);
    const loop = await updateArea(w.db, { orgId: ORG, areaId: building, parentId: wing });
    expect(loop).toMatchObject({ ok: false });
    const dup = await createArea(w.db, {
      orgId: ORG,
      siteId: SITE,
      parentId: building,
      name: 'Level 2',
    });
    expect(dup.ok).toBe(false);
  });
});

describe('changing how a device is reached', () => {
  it('moves it to another gateway, back to automatic, and refuses a gateway at another site', async () => {
    const w = world();
    const id = await activeDevice(w);
    const set = (gatewayId: string | null) =>
      updateDevice(w.db, { orgId: ORG, deviceId: id, actorId: 'u1', patch: { gatewayId } });
    expect((await set(GW_OTHER)).ok).toBe(true);
    expect(w.device.rows[0]).toMatchObject({ gatewayId: GW_OTHER, version: 2 });
    expect((await set(null)).ok).toBe(true);
    expect(w.device.rows[0]).toMatchObject({ gatewayId: null, version: 3 });
    w.gateway.rows.push({
      id: '99999999-9999-4999-8999-999999999993',
      orgId: ORG,
      siteId: '22222222-2222-4222-8222-222222222299',
      createdAt: at(0),
    });
    const bad = await set('99999999-9999-4999-8999-999999999993');
    expect(bad).toMatchObject({ ok: false, message: 'That gateway is not in this site' });
    expect(w.device.rows[0]!.version).toBe(3);
    expect(w.deviceEvent.rows.filter((e) => e.type === 'gateway_changed')).toHaveLength(2);
  });

  it('changing the driver drops the control points the new driver cannot read', async () => {
    const w = world();
    const id = await activeDevice(w);
    const gain = {
      id: 'g',
      name: 'Gain',
      type: 'level',
      address: { component: 'Room', control: 'gain' },
    };
    const named = {
      id: 'n',
      name: 'Scene',
      type: 'generic',
      address: { control: 'Scene' },
    };
    Object.assign(w.device.rows[0]!, {
      control: { kind: 'driver', driverId: 'qsys-core' },
      points: [gain, named],
      pointValues: { g: 50 },
    });
    // A PJLink projector reads no points.
    await updateDevice(w.db, {
      orgId: ORG,
      deviceId: id,
      actorId: 'u1',
      patch: { control: { kind: 'driver', driverId: 'pjlink' } },
    });
    expect(w.device.rows[0]).toMatchObject({ points: [] });
    expect(w.device.rows[0]!.pointValues).not.toEqual({ g: 50 });
    expect(w.deviceEvent.rows.some((e) => e.field === 'control points')).toBe(true);
  });
});
