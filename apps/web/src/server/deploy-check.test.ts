import { describe, expect, it } from 'vitest';
import { RoomModel, type Device } from '@kestrel/model';
import { checkDeployable, gatewayTooOld, setupProblem, type DeployCheckDb } from './deploy-check';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const ROOM = '33333333-3333-4333-8333-333333333331';
const GW = '99999999-9999-4999-8999-999999999991';
const REL = '44444444-4444-4444-8444-444444444441';

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

function world(opts: { features?: string[]; external?: boolean; devices?: Device[] } = {}) {
  const model = room(opts.devices ?? [proj]);
  const release = table([
    {
      id: REL,
      orgId: ORG,
      roomId: ROOM,
      manifest: { manifest: { model, drivers: {}, ...(opts.external ? { bindingsExternal: true } : {}) } },
    },
  ]);
  const gateway = table([{ id: GW, orgId: ORG, features: opts.features ?? [] }]);
  const roomBinding = table([]);
  const credentialSet = table([]);
  const db = { release, gateway, roomBinding, credentialSet } as unknown as DeployCheckDb;
  return { db, roomBinding };
}
const input = { orgId: ORG, roomId: ROOM, gatewayId: GW, releaseId: REL };

describe('setupProblem', () => {
  it('is null when nothing required is missing, and names the first thing when something is', () => {
    expect(setupProblem(room([{ ...proj, control: undefined }]), {})).toBeNull();
    expect(setupProblem(room([proj]), {})).toMatch(/^Needs setup: Projector needs its address/);
    expect(setupProblem(room([proj]), { proj: { host: '10.0.0.9' } })).toBeNull();
  });

  it('counts the rest', () => {
    const two = [proj, { ...proj, id: 'proj2', name: 'Projector 2' }];
    expect(setupProblem(room(two), {})).toMatch(/\(and 1 more\)/);
  });
});

describe('checkDeployable', () => {
  it('blocks a room whose address has not been filled in', async () => {
    const res = await checkDeployable(world().db, input);
    expect(res).toMatchObject({ ok: false });
    expect(!res.ok && res.message).toMatch(/Needs setup/);
  });

  it('allows it once the address is in the bindings', async () => {
    const w = world();
    w.roomBinding.rows.push({ id: 'b', orgId: ORG, roomId: ROOM, version: 1, values: { proj: { host: '10.0.0.9' } }, sealed: null, credentialSets: {} });
    expect(await checkDeployable(w.db, input)).toEqual({ ok: true });
  });

  it('allows an address still inline in an older release', async () => {
    const w = world({ devices: [{ ...proj, settings: { host: '10.0.0.9' } }] });
    expect(await checkDeployable(w.db, input)).toEqual({ ok: true });
  });

  it('blocks a release that keeps its addresses apart from a gateway that cannot fetch them', async () => {
    const w = world({ external: true, features: [] });
    w.roomBinding.rows.push({ id: 'b', orgId: ORG, roomId: ROOM, version: 1, values: { proj: { host: '10.0.0.9' } }, sealed: null, credentialSets: {} });
    const res = await checkDeployable(w.db, input);
    expect(!res.ok && res.message).toMatch(/needs updating/);
  });

  it('allows it for a gateway that says it can', async () => {
    const w = world({ external: true, features: ['bindings'] });
    w.roomBinding.rows.push({ id: 'b', orgId: ORG, roomId: ROOM, version: 1, values: { proj: { host: '10.0.0.9' } }, sealed: null, credentialSets: {} });
    expect(await checkDeployable(w.db, input)).toEqual({ ok: true });
  });

  it('refuses a release from another room or organisation', async () => {
    const res = await checkDeployable(world().db, { ...input, orgId: '11111111-1111-4111-8111-111111111112' });
    expect(res).toEqual({ ok: false, message: 'That release does not exist' });
  });
});

describe('gateway too old', () => {
  const pressKey = (id = 'proj') => ({
    ...proj,
    id,
    settings: { host: '10.0.0.9' },
  });
  const withAction = (): Device[] => [pressKey()];
  const modelNeeding = () =>
    RoomModel.parse({
      roomType: 'meeting',
      devices: withAction(),
      activities: [
        {
          id: 'present',
          name: 'Present',
          kind: 'present',
          actions: [{ id: 'a1', type: 'press_key', deviceId: 'proj', key: 'home' }],
        },
      ],
    });

  it('blocks a release that presses keys or launches apps on a gateway that cannot', async () => {
    const w = world({ features: ['bindings'] });
    (w.db.release as unknown as { rows: { manifest: { manifest: { model: unknown } } }[] }).rows[0]!.manifest.manifest.model = modelNeeding();
    const res = await checkDeployable(w.db, input);
    expect(!res.ok && res.message).toMatch(/too old/);
  });

  it('allows it once the gateway says it can', async () => {
    const w = world({ features: ['bindings', 'display-extras'] });
    (w.db.release as unknown as { rows: { manifest: { manifest: { model: unknown } } }[] }).rows[0]!.manifest.manifest.model = modelNeeding();
    expect(await checkDeployable(w.db, input)).toEqual({ ok: true });
  });

  it('does not ask an ordinary room for anything', async () => {
    expect(await gatewayTooOld(world().db, ORG, GW, room([proj]))).toBeNull();
  });
});
