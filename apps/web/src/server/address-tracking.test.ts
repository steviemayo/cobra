import { beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPair, generateSealKey } from '@kestrel/crypto';
import { Prisma } from '@kestrel/db';
import type { DeviceReport } from '@kestrel/model';
import {
  AddressError,
  applyAddressReport,
  checkTrackingInput,
  configuredAddress,
  requestRefind,
  trackingFor,
  useAddress,
  validAddress,
  withTracking,
} from './address-tracking';
import {
  createDevice,
  deviceSetVersion,
  recordDeviceReports,
  signedDeviceSetFor,
  updateDevice,
  type DevicesDb,
} from './devices';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const GW = '99999999-9999-4999-8999-999999999991';
const T0 = new Date('2026-10-03T10:00:00Z');
const MAC = 'aa:bb:cc:dd:ee:01';

beforeAll(() => {
  process.env.KESTREL_SECRETS_KEY = generateSealKey();
});

function world() {
  const device = table([]);
  const deviceEvent = table([]);
  const db = {
    device,
    deviceEvent,
    deviceHistory: table([]),
    room: table([]),
    gateway: table([{ id: GW, orgId: ORG, siteId: SITE, createdAt: T0 }]),
    incident: table([]),
    credentialSet: table([]),
    area: table([]),
    site: table([{ id: SITE, orgId: ORG }]),
  } as unknown as DevicesDb;
  return { db, device, deviceEvent };
}
const gw = { id: GW, orgId: ORG, siteId: SITE };

async function tracked(w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) {
  const res = await createDevice(w.db, {
    orgId: ORG,
    siteId: SITE,
    kind: 'active',
    actorId: null,
    name: 'Projector',
    category: 'display',
    control: { kind: 'generic', protocol: 'pjlink' },
    values: { host: '10.0.0.5' },
    gatewayId: GW,
    addressMode: 'tracked',
    hostname: 'proj.local',
    mac: 'AA-BB-CC-DD-EE-01',
    ...extra,
  });
  if (!res.ok) throw new Error(res.message);
  return res.value.id;
}
const report = (deviceId: string, over: Partial<DeviceReport> = {}): DeviceReport => ({
  deviceId,
  name: 'Projector',
  online: true,
  ...over,
});
const row = (w: ReturnType<typeof world>) => w.device.rows[0]!;

describe('the details a gateway is given', () => {
  it('only a tracked device has them, with the MAC in one form', () => {
    const base = {
      hostname: 'p.local',
      mac: 'AA-BB-CC-DD-EE-01',
      serial: 'S1',
      name: 'P',
      refindAt: null,
    };
    expect(trackingFor({ ...base, addressMode: 'fixed' })).toBeUndefined();
    expect(trackingFor({ ...base, addressMode: 'tracked' })).toEqual({
      mac: MAC,
      hostname: 'p.local',
      serial: 'S1',
      name: 'P',
    });
    expect(withTracking({ host: 'x' }, { ...base, addressMode: 'fixed' })).toEqual({ host: 'x' });
    expect(withTracking({ host: 'x' }, { ...base, addressMode: 'tracked' })).toMatchObject({
      host: 'x',
      addressTracking: { mac: MAC },
    });
  });

  it('is in the signed device set, and a Find again changes its version', async () => {
    const w = world();
    const id = await tracked(w);
    const { publicKeyPem, privateKeyPem } = generateKeyPair();
    const signed = await signedDeviceSetFor(w.db, gw, { privateKeyPem, publicKeyPem, keyId: 'k' });
    expect(signed.payload.devices[0]!.settings).toMatchObject({
      host: '10.0.0.5',
      addressTracking: { mac: MAC, hostname: 'proj.local', name: 'Projector' },
    });
    const before = await deviceSetVersion(w.db, gw);
    await requestRefind(w.db, { orgId: ORG, deviceId: id }, T0);
    expect(await deviceSetVersion(w.db, gw)).not.toBe(before);
    const again = await signedDeviceSetFor(w.db, gw, { privateKeyPem, publicKeyPem, keyId: 'k' });
    expect(again.payload.devices[0]!.settings).toMatchObject({
      addressTracking: { refindAt: T0.toISOString() },
    });
  });
});

describe('checking what a person types', () => {
  it('accepts a MAC in any common form and refuses one that is not', () => {
    expect(checkTrackingInput({ mac: 'AA-BB-CC-DD-EE-01' }, true)).toMatchObject({
      ok: true,
      mac: MAC,
    });
    expect(checkTrackingInput({ mac: 'aabb.ccdd.ee01' }, true)).toMatchObject({
      ok: true,
      mac: MAC,
    });
    expect(checkTrackingInput({ mac: 'nonsense' }, true)).toMatchObject({ ok: false });
    // A fixed device's asset record is left as typed.
    expect(checkTrackingInput({ mac: 'nonsense' }, false)).toMatchObject({ ok: true });
  });

  it('accepts a hostname but not an IP address, and refuses an unknown mode', () => {
    expect(checkTrackingInput({ hostname: ' proj.local ' }, true)).toMatchObject({
      ok: true,
      hostname: 'proj.local',
    });
    expect(checkTrackingInput({ hostname: '' }, true)).toMatchObject({ ok: true, hostname: null });
    expect(checkTrackingInput({ hostname: '10.0.0.5' }, true)).toMatchObject({ ok: false });
    expect(checkTrackingInput({ hostname: 'bad name!' }, true)).toMatchObject({ ok: false });
    expect(checkTrackingInput({ addressMode: 'roaming' }, false)).toMatchObject({ ok: false });
  });

  it('allows private addresses and names, never a public address', () => {
    for (const a of ['10.1.2.3', '172.16.0.9', '192.168.5.5', '169.254.1.1', 'proj.local'])
      expect(validAddress(a)).toBe(true);
    for (const a of ['8.8.8.8', '172.32.0.1', '999.1.1.1', '1.2.3', ''])
      expect(validAddress(a)).toBe(false);
  });

  it('only a monitored device can be tracked', async () => {
    const w = world();
    const res = await createDevice(w.db, {
      orgId: ORG,
      siteId: SITE,
      kind: 'passive',
      actorId: null,
      name: 'Laptop',
      category: 'laptop',
      addressMode: 'tracked',
    });
    expect(res).toMatchObject({ ok: false });
  });
});

describe('creating and editing', () => {
  it('stores the mode, hostname and normalised MAC', async () => {
    const w = world();
    await tracked(w);
    expect(row(w)).toMatchObject({ addressMode: 'tracked', hostname: 'proj.local', mac: MAC });
  });

  it('a fixed device keeps the defaults and no hostname', async () => {
    const w = world();
    await tracked(w, { addressMode: 'fixed', hostname: 'ignored.local' });
    expect(row(w)).toMatchObject({ addressMode: 'fixed', hostname: null });
  });

  it('switching to tracked, or changing the MAC of a tracked device, goes to the gateway; switching back clears the problem', async () => {
    const w = world();
    const id = await tracked(w, { addressMode: 'fixed' });
    const v = () => row(w).version as number;
    const v0 = v();
    await updateDevice(w.db, {
      orgId: ORG,
      deviceId: id,
      actorId: null,
      patch: { addressMode: 'tracked' },
    });
    expect(v()).toBe(v0 + 1);
    await updateDevice(w.db, {
      orgId: ORG,
      deviceId: id,
      actorId: null,
      patch: { mac: 'aa:bb:cc:dd:ee:02' },
    });
    expect(v()).toBe(v0 + 2);
    expect(row(w).mac).toBe('aa:bb:cc:dd:ee:02');
    await updateDevice(w.db, {
      orgId: ORG,
      deviceId: id,
      actorId: null,
      patch: { mac: 'bad' },
    }).then((r) => expect(r).toMatchObject({ ok: false }));
    row(w).addressSuggestion = { at: 'x' };
    await updateDevice(w.db, {
      orgId: ORG,
      deviceId: id,
      actorId: null,
      patch: { addressMode: 'fixed' },
    });
    expect(row(w).addressSuggestion).toBe(Prisma.DbNull);
  });
});

describe('what a gateway says about the address', () => {
  const move = { from: '10.0.0.5', to: '10.0.0.77', how: 'mac' as const };

  it('moves a tracked device: the address it is given, the history, the asset IP and an event', async () => {
    const w = world();
    const id = await tracked(w);
    const v0 = row(w).version as number;
    await recordDeviceReports(w.db, gw, [report(id, { address: { change: move } })], T0);
    expect(row(w).values).toEqual({ host: '10.0.0.77' });
    expect(row(w).version).toBe(v0 + 1);
    expect(row(w).ip).toBe('10.0.0.77');
    expect(row(w).addressHistory).toEqual([
      { at: T0.toISOString(), from: '10.0.0.5', to: '10.0.0.77', how: 'mac' },
    ]);
    expect(w.deviceEvent.rows.find((e) => e.type === 'address_changed')).toMatchObject({
      oldValue: '10.0.0.5',
      newValue: '10.0.0.77',
      source: 'discovered',
    });
    expect(configuredAddress(row(w).values)).toBe('10.0.0.77');
  });

  it('says it once: the gateway keeps reporting until its set carries the address', async () => {
    const w = world();
    const id = await tracked(w);
    await recordDeviceReports(w.db, gw, [report(id, { address: { change: move } })], T0);
    const v = row(w).version;
    await recordDeviceReports(w.db, gw, [report(id, { address: { change: move } })], T0);
    expect(row(w).version).toBe(v);
    expect((row(w).addressHistory as unknown[]).length).toBe(1);
  });

  it('refuses an address that is not private, and never moves a fixed device', async () => {
    const w = world();
    const id = await tracked(w);
    await recordDeviceReports(
      w.db,
      gw,
      [report(id, { address: { change: { ...move, to: '8.8.8.8' } } })],
      T0,
    );
    expect(row(w).values).toEqual({ host: '10.0.0.5' });
    const f = world();
    const fid = await tracked(f, { addressMode: 'fixed' });
    await recordDeviceReports(f.db, gw, [report(fid, { address: { change: move } })], T0);
    expect(row(f).values).toEqual({ host: '10.0.0.5' });
  });

  it('keeps candidates and problems as a suggestion, and clears it once the device is online again', async () => {
    const w = world();
    const id = await tracked(w);
    await recordDeviceReports(
      w.db,
      gw,
      [
        report(id, {
          online: false,
          address: {
            candidates: [
              { address: '10.0.0.80', note: 'Answers on the same port' },
              { address: '8.8.8.8', note: 'x' },
            ],
          },
        }),
      ],
      T0,
    );
    expect(row(w).addressSuggestion).toMatchObject({
      candidates: [{ address: '10.0.0.80' }],
    });
    await recordDeviceReports(w.db, gw, [report(id, { online: true })], T0);
    expect(row(w).addressSuggestion).toBe(Prisma.DbNull);
  });

  it('records the MAC the gateway learned', async () => {
    const w = world();
    const id = await tracked(w, { mac: undefined });
    await recordDeviceReports(w.db, gw, [report(id, { address: { mac: MAC } })], T0);
    expect(row(w).mac).toBe(MAC);
  });

  it('applyAddressReport leaves a fixed device alone', () => {
    const patch: Record<string, unknown> = {};
    const out = applyAddressReport(
      {
        addressMode: 'fixed',
        values: {},
        settings: {},
        addressHistory: [],
        addressSuggestion: null,
        version: 1,
      },
      { change: move },
      true,
      patch,
      T0,
    );
    expect(out).toBeNull();
    expect(patch).toEqual({});
  });
});

describe('people choosing an address', () => {
  it('uses one for a tracked or fixed active device, with history and an event, and tells the gateway', async () => {
    const w = world();
    const id = await tracked(w);
    row(w).addressSuggestion = { at: 'x' };
    const v0 = row(w).version as number;
    await useAddress(w.db, { orgId: ORG, deviceId: id, address: '10.0.0.90', actorId: null }, T0);
    expect(row(w)).toMatchObject({ version: v0 + 1, values: { host: '10.0.0.90' } });
    expect(row(w).addressSuggestion).toBe(Prisma.DbNull);
    expect((row(w).addressHistory as { how: string }[])[0]!.how).toBe('manual');
    expect(w.deviceEvent.rows.at(-1)).toMatchObject({ type: 'address_changed', source: 'manual' });
    // Choosing the address it already has changes nothing.
    await useAddress(w.db, { orgId: ORG, deviceId: id, address: '10.0.0.90', actorId: null }, T0);
    expect(row(w).version).toBe(v0 + 1);
  });

  it('refuses a public address, another organisation, and Find again on a fixed device', async () => {
    const w = world();
    const id = await tracked(w);
    await expect(
      useAddress(w.db, { orgId: ORG, deviceId: id, address: '8.8.8.8', actorId: null }),
    ).rejects.toThrow(AddressError);
    await expect(
      useAddress(w.db, { orgId: 'other', deviceId: id, address: '10.0.0.9', actorId: null }),
    ).rejects.toThrow(/No such device/);
    await updateDevice(w.db, {
      orgId: ORG,
      deviceId: id,
      actorId: null,
      patch: { addressMode: 'fixed' },
    });
    await expect(requestRefind(w.db, { orgId: ORG, deviceId: id })).rejects.toThrow(/tracking/);
  });
});
