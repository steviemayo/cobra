import { describe, expect, it } from 'vitest';
import { generateKeyPair, generateSealKey, open, verifyBindings } from '@kestrel/crypto';
import { RoomModel, type Device } from '@kestrel/model';
import {
  absorbInline,
  bindingView,
  createCredentialSet,
  deleteCredentialSet,
  listCredentialSets,
  resolveBindings,
  saveDeviceBinding,
  saveDeviceBindings,
  signedBindingsFor,
  updateCredentialSet,
  type BindingsDb,
} from './bindings';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '11111111-1111-4111-8111-111111111112';
const ROOM = '33333333-3333-4333-8333-333333333331';
const ROOM2 = '33333333-3333-4333-8333-333333333332';
const KEY = generateSealKey();

const dsp: Device = {
  id: 'dsp',
  name: 'DSP',
  category: 'audio_matrix',
  ports: [],
  extraCapabilities: [],
  control: { kind: 'driver', driverId: 'qsys-core' },
  settings: {},
};
const proj: Device = {
  id: 'proj',
  name: 'Projector',
  category: 'projector',
  ports: [],
  extraCapabilities: [],
  control: { kind: 'generic', protocol: 'pjlink' },
  settings: {},
};
const room = (devices: Device[]) => RoomModel.parse({ roomType: 'meeting', devices });

function world() {
  const roomBinding = table([]);
  const credentialSet = table([]);
  const siteDevice = table([]);
  return { db: { roomBinding, credentialSet, siteDevice } as unknown as BindingsDb, roomBinding, credentialSet, siteDevice };
}
const base = { orgId: ORG, roomId: ROOM, userId: 'u1' };

describe('saving a device binding', () => {
  it('stores an address as it is and seals a password', async () => {
    const w = world();
    const r = await saveDeviceBinding(
      w.db,
      { ...base, device: dsp, set: { host: '10.0.0.5', password: 'hunter2' } },
      KEY,
    );
    expect(r).toEqual({ ok: true, version: 1 });
    const row = w.roomBinding.rows[0]!;
    expect(row.values).toEqual({ dsp: { host: '10.0.0.5' } });
    expect(JSON.stringify(row)).not.toContain('hunter2');
    expect(JSON.parse(open(row.sealed as string, KEY))).toEqual({ dsp: { password: 'hunter2' } });
  });

  it('bumps the version on every change and clears with an empty value', async () => {
    const w = world();
    await saveDeviceBinding(w.db, { ...base, device: dsp, set: { host: '10.0.0.5' } }, KEY);
    const r = await saveDeviceBinding(w.db, { ...base, device: dsp, set: { host: '' } }, KEY);
    expect(r).toEqual({ ok: true, version: 2 });
    expect(w.roomBinding.rows[0]!.values).toEqual({});
    expect(w.roomBinding.rows).toHaveLength(1);
  });

  it('refuses a design setting: that belongs in the device editor', async () => {
    const w = world();
    const r = await saveDeviceBinding(w.db, { ...base, device: dsp, set: { gainComponent: 'x' } }, KEY);
    expect(r).toMatchObject({ ok: false });
    expect(w.roomBinding.rows).toHaveLength(0);
  });

  it('refuses a login when the server has no secrets key, but still stores addresses', async () => {
    const w = world();
    expect(await saveDeviceBinding(w.db, { ...base, device: dsp, set: { password: 'x' } }, undefined)).toMatchObject({
      ok: false,
    });
    expect(await saveDeviceBinding(w.db, { ...base, device: dsp, set: { host: '10.0.0.5' } }, undefined)).toMatchObject({
      ok: true,
    });
  });
});

describe('saving many device bindings at once', () => {
  it('gives the room one new version for all of them', async () => {
    const w = world();
    const r = await saveDeviceBindings(
      w.db,
      {
        ...base,
        changes: [
          { device: dsp, set: { host: '10.0.0.5', password: 'hunter2' } },
          { device: proj, set: { host: '10.0.0.9' } },
        ],
      },
      KEY,
    );
    expect(r).toEqual({ ok: true, version: 1 });
    expect(w.roomBinding.rows[0]!.values).toEqual({ dsp: { host: '10.0.0.5' }, proj: { host: '10.0.0.9' } });
    expect(JSON.parse(open(w.roomBinding.rows[0]!.sealed as string, KEY))).toEqual({ dsp: { password: 'hunter2' } });
  });

  it('saves nothing when one of the changes is not allowed', async () => {
    const w = world();
    const r = await saveDeviceBindings(
      w.db,
      { ...base, changes: [{ device: dsp, set: { host: '10.0.0.5' } }, { device: proj, set: { inputs: 'x' } }] },
      KEY,
    );
    expect(r).toMatchObject({ ok: false });
    expect(w.roomBinding.rows).toHaveLength(0);
  });
});

describe('what a gateway gets', () => {
  it('is nothing for a room with no bindings', async () => {
    expect(await resolveBindings(world().db, ORG, ROOM, KEY)).toBeNull();
  });

  it('puts a credential set under the device’s own values', async () => {
    const w = world();
    const set = await createCredentialSet(
      w.db,
      { orgId: ORG, name: 'Site DSP', fields: { username: 'admin', password: 'setpw' }, userId: null },
      KEY,
    );
    if (!set.ok) throw new Error(set.message);
    await saveDeviceBinding(w.db, { ...base, device: dsp, credentialSetId: set.id, set: { host: '10.0.0.5' } }, KEY);
    expect(await resolveBindings(w.db, ORG, ROOM, KEY)).toEqual({
      version: 1,
      devices: { dsp: { username: 'admin', password: 'setpw', host: '10.0.0.5' } },
      sharedDevices: {},
    });
    // The device's own login wins over the shared one.
    await saveDeviceBinding(w.db, { ...base, device: dsp, set: { password: 'own' } }, KEY);
    expect((await resolveBindings(w.db, ORG, ROOM, KEY))!.devices.dsp).toMatchObject({ username: 'admin', password: 'own' });
  });

  it('is signed so a gateway can trust it, and a tampered copy is refused', async () => {
    const w = world();
    await saveDeviceBinding(w.db, { ...base, device: dsp, set: { host: '10.0.0.5', password: 'pw' } }, KEY);
    const pair = generateKeyPair();
    const signing = { keyId: 'k1', ...pair };
    const signed = await signedBindingsFor(w.db, ORG, ROOM, signing, KEY);
    const wire = JSON.parse(JSON.stringify(signed)) as { payload: { devices: { dsp: { host: string } } } };
    const trusted = [{ keyId: 'k1', publicKeyPem: pair.publicKeyPem }];
    expect(verifyBindings(wire, trusted).ok).toBe(true);
    wire.payload.devices.dsp.host = '6.6.6.6';
    expect(verifyBindings(wire, trusted).ok).toBe(false);
  });
});

describe('what a browser sees', () => {
  it('shows addresses, never passwords, and says what is missing', async () => {
    const w = world();
    await saveDeviceBinding(w.db, { ...base, device: dsp, set: { host: '10.0.0.5', password: 'hunter2' } }, KEY);
    const view = await bindingView(w.db, { orgId: ORG, roomId: ROOM, model: room([dsp, proj]) }, KEY);
    const d = view.devices.find((x) => x.deviceId === 'dsp')!;
    expect(d.slots.find((s) => s.key === 'host')).toMatchObject({ value: '10.0.0.5', isSet: true });
    const pw = d.slots.find((s) => s.key === 'password')!;
    expect(pw.isSet).toBe(true);
    expect(pw).not.toHaveProperty('value');
    expect(JSON.stringify(view)).not.toContain('hunter2');
    expect(view.missing.map((m) => m.deviceId)).toEqual(['proj']);
    expect(view.version).toBe(1);
  });

  it('says a login comes from a credential set', async () => {
    const w = world();
    const set = await createCredentialSet(w.db, { orgId: ORG, name: 'Shared', fields: { password: 'p' }, userId: null }, KEY);
    if (!set.ok) throw new Error(set.message);
    await saveDeviceBinding(w.db, { ...base, device: dsp, credentialSetId: set.id, set: { host: '1.1.1.1' } }, KEY);
    const view = await bindingView(w.db, { orgId: ORG, roomId: ROOM, model: room([dsp]) }, KEY);
    const pw = view.devices[0]!.slots.find((s) => s.key === 'password')!;
    expect(pw).toMatchObject({ isSet: true, fromCredentialSet: true });
    expect(view.devices[0]!.credentialSetId).toBe(set.id);
  });
});

describe('absorbing inline settings', () => {
  const legacy = () =>
    room([
      { ...dsp, settings: { host: '10.0.0.5', password: 'hunter2', gainComponent: 'Gain1' } },
      { ...proj, settings: { host: '10.0.0.9', inputs: { in: '31' } } },
    ]);

  it('moves addresses and logins out of the design and into the bindings', async () => {
    const w = world();
    const { model, version } = await absorbInline(w.db, { ...base, model: legacy() }, KEY);
    expect(model.devices.map((d) => d.settings)).toEqual([{ gainComponent: 'Gain1' }, { inputs: { in: '31' } }]);
    expect(version).toBe(1);
    expect((await resolveBindings(w.db, ORG, ROOM, KEY))!.devices).toEqual({
      dsp: { host: '10.0.0.5', password: 'hunter2' },
      proj: { host: '10.0.0.9' },
    });
  });

  it('never overwrites a value already in the bindings, and does not bump the version for nothing', async () => {
    const w = world();
    await saveDeviceBinding(w.db, { ...base, device: dsp, set: { host: '9.9.9.9' } }, KEY);
    const first = await absorbInline(w.db, { ...base, model: legacy() }, KEY);
    expect((await resolveBindings(w.db, ORG, ROOM, KEY))!.devices.dsp!.host).toBe('9.9.9.9');
    const again = await absorbInline(w.db, { ...base, model: legacy() }, KEY);
    expect(again.version).toBe(first.version);
  });

  it('with no secrets key, keeps logins inline and still moves addresses', async () => {
    const w = world();
    const { model } = await absorbInline(w.db, { ...base, model: legacy() }, undefined);
    expect(model.devices[0]!.settings).toEqual({ gainComponent: 'Gain1', password: 'hunter2' });
    expect(w.roomBinding.rows[0]!.values).toEqual({ dsp: { host: '10.0.0.5' }, proj: { host: '10.0.0.9' } });
  });

  it('leaves a room with nothing to move alone', async () => {
    const w = world();
    const { model, version } = await absorbInline(w.db, { ...base, model: room([dsp]) }, KEY);
    expect(model.devices).toHaveLength(1);
    expect(version).toBeUndefined();
    expect(w.roomBinding.rows).toHaveLength(0);
  });
});

describe('credential sets', () => {
  const make = (w: ReturnType<typeof world>, name = 'Site DSP') =>
    createCredentialSet(w.db, { orgId: ORG, name, fields: { username: 'admin', password: 'pw' }, userId: 'u1' }, KEY);

  it('are sealed, listed by field name only, and names are unique per organisation', async () => {
    const w = world();
    expect(await make(w)).toMatchObject({ ok: true });
    expect(JSON.stringify(w.credentialSet.rows)).not.toContain('"pw"');
    expect(await make(w)).toMatchObject({ ok: false });
    expect(
      await createCredentialSet(w.db, { orgId: OTHER_ORG, name: 'Site DSP', fields: { password: 'x' }, userId: null }, KEY),
    ).toMatchObject({ ok: true });
    const list = await listCredentialSets(w.db, ORG);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Site DSP', fields: ['password', 'username'], usedBy: 0 });
    expect(JSON.stringify(list)).not.toContain('pw');
  });

  it('need a name, a field and a secrets key', async () => {
    const w = world();
    expect(await createCredentialSet(w.db, { orgId: ORG, name: ' ', fields: { a: 'b' }, userId: null }, KEY)).toMatchObject({ ok: false });
    expect(await createCredentialSet(w.db, { orgId: ORG, name: 'x', fields: {}, userId: null }, KEY)).toMatchObject({ ok: false });
    expect(await createCredentialSet(w.db, { orgId: ORG, name: 'x', fields: { a: 'b' }, userId: null }, undefined)).toMatchObject({ ok: false });
  });

  it('rotating a password gives every room that uses it a new version, and nothing else', async () => {
    const w = world();
    const set = await make(w);
    if (!set.ok) throw new Error(set.message);
    await saveDeviceBinding(w.db, { ...base, device: dsp, credentialSetId: set.id, set: { host: '1.1.1.1' } }, KEY);
    await saveDeviceBinding(w.db, { ...base, roomId: ROOM2, device: dsp, credentialSetId: set.id, set: { host: '2.2.2.2' } }, KEY);
    await saveDeviceBinding(w.db, { ...base, roomId: '33333333-3333-4333-8333-333333333399', device: dsp, set: { host: '3.3.3.3' } }, KEY);
    const r = await updateCredentialSet(w.db, { orgId: ORG, id: set.id, fields: { password: 'rotated' }, userId: 'u1' }, KEY);
    expect(r).toMatchObject({ ok: true, roomsUpdated: 2 });
    expect(w.roomBinding.rows.map((x) => x.version)).toEqual([2, 2, 1]);
    expect((await resolveBindings(w.db, ORG, ROOM, KEY))!.devices.dsp).toMatchObject({ username: 'admin', password: 'rotated' });
  });

  it('cannot lose its last field, and an empty value removes one', async () => {
    const w = world();
    const set = await make(w);
    if (!set.ok) throw new Error(set.message);
    expect(await updateCredentialSet(w.db, { orgId: ORG, id: set.id, fields: { username: '' }, userId: null }, KEY)).toMatchObject({ ok: true });
    expect((await listCredentialSets(w.db, ORG))[0]!.fields).toEqual(['password']);
    expect(await updateCredentialSet(w.db, { orgId: ORG, id: set.id, fields: { password: '' }, userId: null }, KEY)).toMatchObject({ ok: false });
  });

  it('cannot be deleted while a room uses it, and cannot be reached from another organisation', async () => {
    const w = world();
    const set = await make(w);
    if (!set.ok) throw new Error(set.message);
    await saveDeviceBinding(w.db, { ...base, device: dsp, credentialSetId: set.id }, KEY);
    expect(await deleteCredentialSet(w.db, ORG, set.id)).toMatchObject({ ok: false });
    expect(await deleteCredentialSet(w.db, OTHER_ORG, set.id)).toMatchObject({ ok: false });
    await saveDeviceBinding(w.db, { ...base, device: dsp, credentialSetId: null }, KEY);
    expect(await deleteCredentialSet(w.db, ORG, set.id)).toEqual({ ok: true });
    expect(await listCredentialSets(w.db, ORG)).toHaveLength(0);
  });

  it('a device cannot use another organisation’s set', async () => {
    const w = world();
    const other = await createCredentialSet(w.db, { orgId: OTHER_ORG, name: 'Theirs', fields: { password: 'x' }, userId: null }, KEY);
    if (!other.ok) throw new Error(other.message);
    expect(await saveDeviceBinding(w.db, { ...base, device: dsp, credentialSetId: other.id }, KEY)).toMatchObject({ ok: false });
  });
});

describe('absorbing conflicting inline values', () => {
  it('reports an inline value that differs from what is stored, and keeps the stored one', async () => {
    const w = world();
    await saveDeviceBinding(w.db, { ...base, device: dsp, set: { host: '9.9.9.9' } }, KEY);
    const model = room([{ ...dsp, settings: { host: '10.0.0.5', gainComponent: 'g' } }]);
    const r = await absorbInline(w.db, { ...base, model }, KEY);
    expect(r.conflicts).toEqual([{ deviceId: 'dsp', deviceName: 'DSP', key: 'host' }]);
    expect(r.model.devices[0]!.settings).toEqual({ gainComponent: 'g' });
    expect((await resolveBindings(w.db, ORG, ROOM, KEY))!.devices.dsp!.host).toBe('9.9.9.9');
  });

  it('does not report a value that matches', async () => {
    const w = world();
    await saveDeviceBinding(w.db, { ...base, device: dsp, set: { host: '9.9.9.9' } }, KEY);
    const r = await absorbInline(w.db, { ...base, model: room([{ ...dsp, settings: { host: '9.9.9.9' } }]) }, KEY);
    expect(r.conflicts).toEqual([]);
  });
});
