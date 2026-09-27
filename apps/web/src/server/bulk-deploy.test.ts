import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '@kestrel/crypto';
import { STARTER_TEMPLATES, slotsFor, type RoomModel } from '@kestrel/model';
import {
  BulkDeployError,
  MAX_BULK_DEPLOY_ROOMS,
  deployBulk,
  planBulkDeploy,
  type BulkDeployDb,
} from './bulk-deploy';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222221';
const GW = '99999999-9999-4999-8999-999999999991';
const [A, B, C] = Array.from(
  { length: 3 },
  (_, i) => `33333333-3333-4333-8333-33333333333${i + 1}`,
) as [string, string, string];

// The starter room with an address and login typed inline for every device that needs one.
const meeting = () => {
  const model = structuredClone(STARTER_TEMPLATES[0]!.model);
  for (const d of model.devices)
    for (const slot of slotsFor(d))
      if (slot.required) d.settings[slot.key] = slot.key === 'port' ? 4352 : `${d.id}-${slot.key}`;
  return model;
};
const pair = generateKeyPair();
const ctx = {
  key: { keyId: 'k1', privateKeyPem: pair.privateKeyPem, publicKeyPem: pair.publicKeyPem },
  orgBranding: { mode: 'dark' as const, language: 'en' },
  userId: 'u1',
};

function world() {
  let n = 0;
  const at = (i: number) => new Date(2026, 0, 1, 0, 0, i);
  const room = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    orgId: ORG,
    name,
    type: 'meeting',
    siteId: SITE,
    gatewayId: GW,
    groupId: null,
    kind: 'standard',
    memberRoomIds: [],
    panel: null,
    desiredReleaseId: null,
    reportedReleaseId: null,
    createdAt: at(n++),
    ...extra,
  });
  const rooms = table([room(A, 'Room A'), room(B, 'Room B'), room(C, 'Room C')]);
  const roomDraft = table(
    [A, B, C].map((roomId) => ({
      id: `d-${roomId}`,
      orgId: ORG,
      roomId,
      model: meeting(),
      revision: 1,
    })),
  );
  const release = table([]);
  const deployment = table([]);
  const customDriver = table([]);
  const customDriverVersion = table([]);
  let seq = 0;
  for (const t of [rooms, roomDraft, deployment, release]) {
    const create = t.create;
    t.create = async (args: { data: Record<string, unknown> }) =>
      create({
        data: {
          id: crypto.randomUUID(),
          createdAt: new Date(2026, 0, 2, 0, 0, ++seq),
          ...args.data,
        },
      });
  }
  const db = {
    room: rooms,
    roomGroup: table([]),
    roomDivider: table([]),
    roomDraft,
    release,
    deployment,
    deploymentEvent: table([]),
    customDriver,
    customDriverVersion,
    roomBinding: table([]),
    credentialSet: table([]),
    siteDevice: table([]),
    gateway: table([{ id: GW, orgId: ORG, features: [] }]),
  } as unknown as BulkDeployDb;
  // The gateway reports that every room is running what it was told to.
  const settle = () => {
    for (const r of rooms.rows) if (r.desiredReleaseId) r.reportedReleaseId = r.desiredReleaseId;
    for (const d of deployment.rows) if (d.status === 'pending') d.status = 'active';
  };
  return { db, rooms, roomDraft, release, deployment, settle, customDriver, customDriverVersion };
}

describe('planning a bulk deploy', () => {
  it('shows what each chosen room would do and changes nothing', async () => {
    const w = world();
    const { plan } = await planBulkDeploy(w.db, ORG, [A, B], 'deploy');
    expect(plan.blocked).toEqual([]);
    expect(plan.steps.map((s) => [s.name, s.action, s.number, s.from])).toEqual([
      ['Room A', 'publish_and_deploy', 1, null],
      ['Room B', 'publish_and_deploy', 1, null],
    ]);
    expect(w.release.rows).toHaveLength(0);
    expect(w.deployment.rows).toHaveLength(0);
  });

  it('reports a room with a problem and still plans the rest', async () => {
    const w = world();
    // Room B has no design; Room C has no gateway.
    w.roomDraft.rows.splice(w.roomDraft.rows.findIndex((d) => d.roomId === B), 1);
    w.rooms.rows.find((r) => r.id === C)!.gatewayId = null;
    const { plan } = await planBulkDeploy(w.db, ORG, [A, B, C], 'deploy');
    expect(plan.steps.map((s) => s.name)).toEqual(['Room A']);
    expect(plan.blocked.map((b) => b.name)).toEqual(['Room B', 'Room C']);
    expect(plan.blocked[0]!.message).toMatch(/Design the room/);
    expect(plan.blocked[1]!.message).toMatch(/gateway/);
  });

  it('reports a room that is not in the organisation', async () => {
    const w = world();
    const { plan } = await planBulkDeploy(w.db, ORG, [A, '44444444-4444-4444-8444-444444444444'], 'deploy');
    expect(plan.steps).toHaveLength(1);
    expect(plan.blocked).toEqual([
      expect.objectContaining({ name: 'Unknown room', message: 'This room was not found.' }),
    ]);
  });

  it('refuses an empty choice and one that is too big', async () => {
    const w = world();
    await expect(planBulkDeploy(w.db, ORG, [], 'deploy')).rejects.toThrow(BulkDeployError);
    const many = Array.from({ length: MAX_BULK_DEPLOY_ROOMS + 1 }, (_, i) => `id-${i}`);
    await expect(planBulkDeploy(w.db, ORG, many, 'deploy')).rejects.toThrow(/up to 100/);
  });

  it('counts the same room once', async () => {
    const w = world();
    const { plan } = await planBulkDeploy(w.db, ORG, [A, A], 'deploy');
    expect(plan.steps).toHaveLength(1);
  });
});

describe('deploying in bulk', () => {
  it('publishes and deploys only the chosen rooms (a canary first)', async () => {
    const w = world();
    const first = await deployBulk(w.db, ORG, [A], 'deploy', ctx);
    expect(first.results.map((r) => [r.name, r.published, r.kind])).toEqual([['Room A', true, 'deploy']]);
    expect(w.release.rows).toHaveLength(1);
    expect(w.rooms.rows.find((r) => r.id === B)!.desiredReleaseId).toBeNull();
    expect(w.rooms.rows.find((r) => r.id === A)!.desiredReleaseId).toBe(w.release.rows[0]!.id);
  });

  it('skips a room that is already on its way, so the canary is not restarted', async () => {
    const w = world();
    await deployBulk(w.db, ORG, [A], 'deploy', ctx);
    const next = await deployBulk(w.db, ORG, [A, B, C], 'deploy', ctx);
    expect(next.skipped.map((s) => [s.name, s.action])).toEqual([['Room A', 'in_progress']]);
    expect(next.results.map((r) => r.name)).toEqual(['Room B', 'Room C']);
    expect(w.deployment.rows.filter((d) => d.roomId === A)).toHaveLength(1);
  });

  it('skips rooms that are already running, and sends a failed one again', async () => {
    const w = world();
    await deployBulk(w.db, ORG, [A, B], 'deploy', ctx);
    w.settle();
    // Room B's deployment then fails on the gateway.
    const rb = w.rooms.rows.find((r) => r.id === B)!;
    rb.reportedReleaseId = null;
    w.deployment.rows.find((d) => d.roomId === B)!.status = 'failed';
    const again = await deployBulk(w.db, ORG, [A, B], 'deploy', ctx);
    expect(again.skipped.map((s) => [s.name, s.action])).toEqual([['Room A', 'up_to_date']]);
    expect(again.results.map((r) => [r.name, r.published])).toEqual([['Room B', false]]);
    expect(w.release.rows.filter((r) => r.roomId === B)).toHaveLength(1);
  });

  it('gives a room a new release only when its design changed', async () => {
    const w = world();
    await deployBulk(w.db, ORG, [A, B], 'deploy', ctx);
    w.settle();
    w.roomDraft.rows.find((d) => d.roomId === A)!.revision = 2;
    const next = await deployBulk(w.db, ORG, [A, B], 'deploy', ctx);
    expect(next.results.map((r) => [r.name, r.number, r.published])).toEqual([['Room A', 2, true]]);
  });

  it('deploys the ready rooms even when another is blocked', async () => {
    const w = world();
    w.roomDraft.rows.splice(w.roomDraft.rows.findIndex((d) => d.roomId === B), 1);
    const res = await deployBulk(w.db, ORG, [A, B, C], 'deploy', ctx);
    expect(res.results.map((r) => r.name)).toEqual(['Room A', 'Room C']);
    expect(res.blocked.map((b) => b.name)).toEqual(['Room B']);
  });
});

describe('rolling back in bulk', () => {
  async function twoReleases() {
    const w = world();
    await deployBulk(w.db, ORG, [A, B], 'deploy', ctx);
    w.settle();
    w.roomDraft.rows.find((d) => d.roomId === A)!.revision = 2;
    await deployBulk(w.db, ORG, [A], 'deploy', ctx);
    w.settle();
    return w;
  }

  it('goes back one release, and blocks a room with nothing earlier', async () => {
    const w = await twoReleases();
    const { plan } = await planBulkDeploy(w.db, ORG, [A, B], 'rollback');
    expect(plan.steps.map((s) => [s.name, s.action, s.number, s.from])).toEqual([['Room A', 'rollback', 1, 2]]);
    expect(plan.blocked.map((b) => [b.name, b.message])).toEqual([
      ['Room B', 'There is no earlier release to go back to.'],
    ]);
  });

  it('points the room at the earlier release with a rollback deployment', async () => {
    const w = await twoReleases();
    const res = await deployBulk(w.db, ORG, [A], 'rollback', ctx);
    expect(res.results.map((r) => [r.name, r.number, r.published, r.kind])).toEqual([['Room A', 1, false, 'rollback']]);
    const first = w.release.rows.find((r) => r.roomId === A && r.number === 1)!;
    expect(w.rooms.rows.find((r) => r.id === A)!.desiredReleaseId).toBe(first.id);
    expect(w.deployment.rows.at(-1)!.kind).toBe('rollback');
  });

  it('blocks a room that has never been deployed', async () => {
    const w = world();
    const { plan } = await planBulkDeploy(w.db, ORG, [C], 'rollback');
    expect(plan.blocked.map((b) => b.message)).toEqual(['Nothing has been deployed to this room yet.']);
  });
});

describe('a driver that has been updated', () => {
  const spec = (version: number, send = 'PWR ON') => ({
    id: 'acme-amp',
    name: 'Acme amp',
    version,
    transport: { type: 'tcp', port: 4001 },
    commands: { 'power.on': { send }, 'power.off': { send: 'PWR OFF' } },
  });

  function withCustomDriver() {
    const w = world();
    w.customDriver.rows.push({ id: 'cd1', orgId: ORG, slug: 'acme-amp', name: 'Acme amp', latestVersion: 1 });
    w.customDriverVersion.rows.push({ driverId: 'cd1', version: 1, spec: spec(1) });
    // The projector-free way: the DSP uses the custom driver, with its address typed in.
    for (const d of w.roomDraft.rows) {
      const model = d.model as RoomModel;
      const dsp = model.devices.find((x) => x.id === 'dsp')!;
      dsp.control = { kind: 'driver', driverId: 'custom:acme-amp' };
      dsp.settings = { ...dsp.settings, host: '10.0.0.5', port: 4001 };
    }
    return w;
  }

  it('gets a new release when deployed, though the design has not changed', async () => {
    const w = withCustomDriver();
    await deployBulk(w.db, ORG, [A], 'deploy', ctx);
    w.settle();
    expect((await planBulkDeploy(w.db, ORG, [A], 'deploy')).plan.steps[0]).toMatchObject({ action: 'up_to_date', number: 1 });

    // The driver is improved: version 2.
    w.customDriverVersion.rows.push({ driverId: 'cd1', version: 2, spec: spec(2, 'ON') });
    w.customDriver.rows[0]!.latestVersion = 2;
    const { plan } = await planBulkDeploy(w.db, ORG, [A], 'deploy');
    expect(plan.steps[0]).toMatchObject({ action: 'publish_and_deploy', number: 2 });

    const out = await deployBulk(w.db, ORG, [A], 'deploy', ctx);
    expect(out.results[0]).toMatchObject({ number: 2, published: true });
    const pinned = (w.release.rows.find((r) => r.number === 2)!.manifest as { manifest: { drivers: Record<string, { spec: { version: number } }> } }).manifest.drivers;
    expect(pinned['custom:acme-amp']!.spec.version).toBe(2);
  });

  it('leaves a room alone whose driver has not changed', async () => {
    const w = withCustomDriver();
    await deployBulk(w.db, ORG, [A, B], 'deploy', ctx);
    w.settle();
    const { plan } = await planBulkDeploy(w.db, ORG, [A, B], 'deploy');
    expect(plan.steps.map((s) => s.action)).toEqual(['up_to_date', 'up_to_date']);
  });
});
