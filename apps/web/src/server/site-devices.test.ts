import { describe, expect, it } from 'vitest';
import { generateSealKey, open, verifyBindings, generateKeyPair } from '@kestrel/crypto';
import { RoomModel, type Device } from '@kestrel/model';
import { bindingView, resolveBindings, signedBindingsFor, saveDeviceBinding, updateCredentialSet, createCredentialSet, deleteCredentialSet } from './bindings';
import {
  createSiteDevice,
  deleteSiteDevice,
  portConflicts,
  sharedGatewayProblem,
  siteDeviceViews,
  updateSiteDevice,
  usesOfSite,
  type SiteDeviceDb,
} from './site-devices';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '11111111-1111-4111-8111-111111111112';
const SITE = '22222222-2222-4222-8222-222222222221';
const GW = '99999999-9999-4999-8999-999999999991';
const GW2 = '99999999-9999-4999-8999-999999999992';
const A = '33333333-3333-4333-8333-333333333331';
const B = '33333333-3333-4333-8333-333333333332';
const KEY = generateSealKey();

const control = { kind: 'driver', driverId: 'qsys-core' } as const;

function world() {
  const siteDevice = table([]);
  // The database fills in these defaults; the in-memory table does not.
  const insert = siteDevice.create;
  siteDevice.create = async ({ data }: { data: Record<string, unknown> }) =>
    insert({ data: { version: 1, settings: {}, values: {}, sealed: null, credentialSetId: null, ...data } });
  const roomBinding = table([]);
  const credentialSet = table([]);
  const site = table([{ id: SITE, orgId: ORG, name: 'HQ' }]);
  const room = table([
    { id: A, orgId: ORG, siteId: SITE, name: 'Room A', gatewayId: GW },
    { id: B, orgId: ORG, siteId: SITE, name: 'Room B', gatewayId: GW },
  ]);
  const roomDraft = table([]);
  const db = { siteDevice, roomBinding, credentialSet, site, room, roomDraft } as unknown as SiteDeviceDb & Parameters<typeof createSiteDevice>[0];
  return { db, siteDevice, roomBinding, credentialSet, room, roomDraft };
}

const create = async (w: ReturnType<typeof world>, over: Record<string, unknown> = {}) => {
  const r = await createSiteDevice(w.db, { orgId: ORG, siteId: SITE, name: 'Core DSP', category: 'audio_matrix', control, userId: 'u1', ...over });
  if (!r.ok) throw new Error(r.message);
  return r.id;
};

/** A room design with a device that is a slice of the shared device. */
const roomUsing = (siteDeviceId: string, ports: Device['ports'] = []) =>
  RoomModel.parse({
    roomType: 'meeting',
    devices: [{ id: 'dsp', name: 'DSP', category: 'audio_matrix', control, siteDeviceId, ports }],
  });
const draft = (w: ReturnType<typeof world>, roomId: string, model: RoomModel) =>
  w.roomDraft.create({ data: { orgId: ORG, roomId, model, revision: 1 } });

describe('creating and changing a shared device', () => {
  it('needs a name, a category, a control and a site, and names are unique per site', async () => {
    const w = world();
    await create(w);
    expect(await createSiteDevice(w.db, { orgId: ORG, siteId: SITE, name: ' core   dsp ', category: 'audio_matrix', control, userId: null })).toMatchObject({ ok: true });
    expect(await createSiteDevice(w.db, { orgId: ORG, siteId: SITE, name: 'Core DSP', category: 'audio_matrix', control, userId: null })).toEqual({
      ok: false,
      message: 'A shared device with that name already exists at this site',
    });
    expect(await createSiteDevice(w.db, { orgId: ORG, siteId: SITE, name: '', category: 'audio_matrix', control, userId: null })).toMatchObject({ ok: false });
    expect(await createSiteDevice(w.db, { orgId: ORG, siteId: SITE, name: 'x', category: 'toaster', control, userId: null })).toMatchObject({ ok: false });
    expect(await createSiteDevice(w.db, { orgId: ORG, siteId: SITE, name: 'y', category: 'audio_matrix', control: { kind: 'nope' }, userId: null })).toMatchObject({ ok: false });
    expect(await createSiteDevice(w.db, { orgId: OTHER_ORG, siteId: SITE, name: 'z', category: 'audio_matrix', control, userId: null })).toEqual({ ok: false, message: 'That site does not exist' });
  });

  it('keeps an address as it is and seals a login, and gives a new version for each change', async () => {
    const w = world();
    const id = await create(w);
    const r = await updateSiteDevice(w.db, { orgId: ORG, id, set: { host: '10.0.0.5', password: 'hunter2' }, userId: 'u1' }, KEY);
    expect(r).toEqual({ ok: true, version: 2 });
    const row = w.siteDevice.rows[0]!;
    expect(row.values).toEqual({ host: '10.0.0.5' });
    expect(JSON.stringify(row)).not.toContain('hunter2');
    expect(JSON.parse(open(row.sealed as string, KEY))).toEqual({ password: 'hunter2' });
    expect(await updateSiteDevice(w.db, { orgId: ORG, id, set: { host: '10.0.0.6' }, userId: 'u1' }, KEY)).toEqual({ ok: true, version: 3 });
    // Nothing changed: the same version.
    expect(await updateSiteDevice(w.db, { orgId: ORG, id, name: 'Core DSP', userId: 'u1' }, KEY)).toEqual({ ok: true, version: 3 });
  });

  it('refuses a design setting as an address, and a login with no secrets key', async () => {
    const w = world();
    const id = await create(w);
    expect(await updateSiteDevice(w.db, { orgId: ORG, id, set: { gainComponent: 'x' }, userId: null }, KEY)).toMatchObject({ ok: false });
    expect(await updateSiteDevice(w.db, { orgId: ORG, id, settings: { host: 'x' }, userId: null }, KEY)).toMatchObject({ ok: false });
    expect(await updateSiteDevice(w.db, { orgId: ORG, id, settings: { gainComponent: 'Room' }, userId: null }, KEY)).toMatchObject({ ok: true });
    expect(await updateSiteDevice(w.db, { orgId: ORG, id, set: { password: 'p' }, userId: null }, undefined)).toEqual({
      ok: false,
      message: 'Storing logins needs KESTREL_SECRETS_KEY on the server',
    });
  });

  it('will not change another organisation’s device, or use another organisation’s credential set', async () => {
    const w = world();
    const id = await create(w);
    expect(await updateSiteDevice(w.db, { orgId: OTHER_ORG, id, name: 'x', userId: null }, KEY)).toMatchObject({ ok: false });
    expect(await updateSiteDevice(w.db, { orgId: ORG, id, credentialSetId: '55555555-5555-4555-8555-555555555555', userId: null }, KEY)).toEqual({
      ok: false,
      message: 'That credential set does not exist',
    });
  });

  it('shows addresses to a browser but never a login, and says whether one is set', async () => {
    const w = world();
    const id = await create(w);
    await updateSiteDevice(w.db, { orgId: ORG, id, set: { host: '10.0.0.5', password: 'hunter2' }, userId: null }, KEY);
    const [view] = await siteDeviceViews(w.db, { orgId: ORG }, KEY);
    expect(JSON.stringify(view)).not.toContain('hunter2');
    expect(view!.slots.find((s) => s.key === 'host')).toMatchObject({ value: '10.0.0.5', isSet: true });
    expect(view!.slots.find((s) => s.key === 'password')).toMatchObject({ isSet: true });
    expect(view!.slots.find((s) => s.key === 'password')).not.toHaveProperty('value');
  });
});

describe('who uses a shared device', () => {
  it('lists the rooms whose designs use it, with their port mappings, and finds two rooms on one port', async () => {
    const w = world();
    const id = await create(w);
    await draft(w, A, roomUsing(id, [{ id: 'out1', name: 'Out', direction: 'out', signal: 'av', maps: 'out3' }]));
    await draft(w, B, roomUsing(id, [{ id: 'out1', name: 'Out', direction: 'out', signal: 'av', maps: 'out3' }]));
    const uses = (await usesOfSite(w.db, ORG, SITE)).get(id)!;
    expect(uses.map((u) => u.roomName).sort()).toEqual(['Room A', 'Room B']);
    expect(portConflicts(uses)).toEqual([{ port: 'out3', rooms: ['Room A', 'Room B'] }]);
    const [view] = await siteDeviceViews(w.db, { orgId: ORG }, KEY);
    expect(view!.uses).toHaveLength(2);
    expect(view!.conflicts).toHaveLength(1);
  });

  it('cannot be deleted while a room uses it, and can be once none does', async () => {
    const w = world();
    const id = await create(w);
    await draft(w, A, roomUsing(id));
    expect(await deleteSiteDevice(w.db, ORG, id)).toEqual({
      ok: false,
      message: 'Room A uses this device. Take it out of their designs first',
    });
    w.roomDraft.rows.length = 0;
    expect(await deleteSiteDevice(w.db, ORG, id)).toEqual({ ok: true });
    expect(w.siteDevice.rows).toHaveLength(0);
  });

  it('keeps every room that shares a device on one gateway', async () => {
    const w = world();
    const id = await create(w);
    await draft(w, A, roomUsing(id));
    const model = roomUsing(id);
    const at = (gatewayId: string) => sharedGatewayProblem(w.db, { orgId: ORG, siteId: SITE, roomId: B, gatewayId, model });
    expect(await at(GW)).toBeNull();
    expect(await at(GW2)).toMatch(/Room A uses the same shared device on a different gateway/);
    w.room.rows[0]!.gatewayId = null;
    expect(await at(GW2)).toBeNull();
    expect(await sharedGatewayProblem(w.db, { orgId: ORG, siteId: SITE, roomId: B, gatewayId: GW2, model: RoomModel.parse({ roomType: 'meeting' }) })).toBeNull();
  });
});

describe('what a room gets from a shared device', () => {
  it('starts from the shared device’s values, with its login, and names it as shared', async () => {
    const w = world();
    const id = await create(w, { exclusive: true });
    await updateSiteDevice(w.db, { orgId: ORG, id, settings: { gainComponent: 'Room' }, set: { host: '10.0.0.5', password: 'hunter2' }, userId: null }, KEY);
    const resolved = await resolveBindings(w.db, ORG, A, KEY, roomUsing(id));
    expect(resolved).toEqual({
      version: 2,
      devices: { dsp: { gainComponent: 'Room', host: '10.0.0.5', password: 'hunter2' } },
      sharedDevices: { dsp: { siteDeviceId: id, exclusive: true } },
    });
  });

  it('gives every room that uses it a new version when its address changes, and only those rooms', async () => {
    const w = world();
    const id = await create(w);
    const model = roomUsing(id);
    const before = (await resolveBindings(w.db, ORG, A, KEY, model))!.version;
    await updateSiteDevice(w.db, { orgId: ORG, id, set: { host: '10.0.0.9' }, userId: null }, KEY);
    expect((await resolveBindings(w.db, ORG, A, KEY, model))!.version).toBeGreaterThan(before);
    expect((await resolveBindings(w.db, ORG, A, KEY, model))!.version).toBe((await resolveBindings(w.db, ORG, B, KEY, model))!.version);
    expect(await resolveBindings(w.db, ORG, A, KEY, RoomModel.parse({ roomType: 'meeting' }))).toBeNull();
  });

  it('a room’s own value wins over the shared one, and the shared device can use a credential set', async () => {
    const w = world();
    const id = await create(w);
    const set = await createCredentialSet(w.db, { orgId: ORG, name: 'Site', fields: { username: 'admin', password: 'setpw' }, userId: null }, KEY);
    if (!set.ok) throw new Error(set.message);
    await updateSiteDevice(w.db, { orgId: ORG, id, set: { host: '10.0.0.5' }, credentialSetId: set.id, userId: null }, KEY);
    expect((await resolveBindings(w.db, ORG, A, KEY, roomUsing(id)))!.devices.dsp).toMatchObject({ host: '10.0.0.5', username: 'admin', password: 'setpw' });
    // Rotating the credential set gives the shared device, and so its rooms, a new version.
    const v = (await resolveBindings(w.db, ORG, A, KEY, roomUsing(id)))!.version;
    const rotated = await updateCredentialSet(w.db, { orgId: ORG, id: set.id, fields: { password: 'new' }, userId: null }, KEY);
    expect(rotated).toMatchObject({ ok: true, roomsUpdated: 1 });
    expect((await resolveBindings(w.db, ORG, A, KEY, roomUsing(id)))!.version).toBe(v + 1);
    // And it cannot be deleted while a shared device uses it.
    expect(await deleteCredentialSet(w.db, ORG, set.id)).toMatchObject({ ok: false });
  });

  it('cannot be changed from a room, and shows the room where the address is kept', async () => {
    const w = world();
    const id = await create(w);
    const model = roomUsing(id);
    const device = model.devices[0]!;
    expect(await saveDeviceBinding(w.db, { orgId: ORG, roomId: A, device, set: { host: 'x' }, userId: null }, KEY)).toMatchObject({
      ok: false,
      message: expect.stringContaining('Shared devices page'),
    });
    const view = await bindingView(w.db, { orgId: ORG, roomId: A, model }, KEY);
    expect(view.devices[0]).toMatchObject({ deviceId: 'dsp', sharedFrom: 'Core DSP' });
    expect(view.missing.map((m) => m.key)).toContain('host');
    await updateSiteDevice(w.db, { orgId: ORG, id, set: { host: '10.0.0.5' }, userId: null }, KEY);
    expect((await bindingView(w.db, { orgId: ORG, roomId: A, model }, KEY)).missing).toEqual([]);
  });

  it('is signed with the list of shared devices, so a gateway knows which connections to share', async () => {
    const w = world();
    const id = await create(w, { exclusive: true });
    await updateSiteDevice(w.db, { orgId: ORG, id, set: { host: '10.0.0.5' }, userId: null }, KEY);
    const pair = generateKeyPair();
    const signing = { keyId: 'k1', privateKeyPem: pair.privateKeyPem, publicKeyPem: pair.publicKeyPem };
    const signed = await signedBindingsFor(w.db, ORG, A, signing, KEY, roomUsing(id));
    const checked = verifyBindings(JSON.parse(JSON.stringify(signed)), [{ keyId: 'k1', publicKeyPem: pair.publicKeyPem }]);
    expect(checked.ok && checked.signed.payload.sharedDevices).toEqual({ dsp: { siteDeviceId: id, exclusive: true } });
  });

  it('a room that uses a shared device that no longer exists gets nothing from it', async () => {
    const w = world();
    const model = roomUsing('55555555-5555-4555-8555-555555555555');
    expect(await resolveBindings(w.db, ORG, A, KEY, model)).toEqual({ version: 1, devices: {}, sharedDevices: {} });
    const view = await bindingView(w.db, { orgId: ORG, roomId: A, model }, KEY);
    expect(view.devices[0]!.sharedFrom).toMatch(/no longer exists/);
  });
});
