import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '@kestrel/crypto';
import { STARTER_TEMPLATES, slotsFor } from '@kestrel/model';
import { deployGroup, planGroupDeploy, type GroupDeployDb } from './group-deploy';
import { saveGroup, syncCombinedRooms } from './room-groups';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222221';
const GW = '99999999-9999-4999-8999-999999999991';
const [A, B, C] = Array.from(
  { length: 3 },
  (_, i) => `33333333-3333-4333-8333-33333333333${i + 1}`,
);

// The starter room with an address and login typed inline for every device that needs one, as rooms
// designed before bindings existed have. A device with a real driver cannot deploy without them.
const meeting = () => {
  const model = structuredClone(STARTER_TEMPLATES[0]!.model);
  for (const d of model.devices)
    for (const slot of slotsFor(d)) if (slot.required) d.settings[slot.key] = slot.key === 'port' ? 4352 : `${d.id}-${slot.key}`;
  return model;
};
const pair = generateKeyPair();
const ctx = {
  key: { keyId: 'k1', privateKeyPem: pair.privateKeyPem, publicKeyPem: pair.publicKeyPem },
  orgBranding: { mode: 'dark' as const, language: 'en' },
  userId: 'u1',
};

async function world({ gateway = GW as string | null } = {}) {
  let n = 0;
  const at = (i: number) => new Date(2026, 0, 1, 0, 0, i);
  const room = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    orgId: ORG,
    name,
    type: 'meeting',
    siteId: SITE,
    gatewayId: gateway,
    groupId: null,
    kind: 'standard',
    memberRoomIds: [],
    panel: null,
    desiredReleaseId: null,
    reportedReleaseId: null,
    createdAt: at(n++),
    ...extra,
  });
  const rooms = table([room(A!, 'Room A'), room(B!, 'Room B'), room(C!, 'Room C')]);
  const roomGroup = table([]);
  const roomDivider = table([]);
  const roomDraft = table(
    [A!, B!, C!].map((roomId) => ({
      id: `d-${roomId}`,
      orgId: ORG,
      roomId,
      model: meeting(),
      revision: 1,
    })),
  );
  const release = table([]);
  const deployment = table([]);
  const deploymentEvent = table([]);
  const customDriver = table([]);
  const customDriverVersion = table([]);
  const roomBinding = table([]);
  const credentialSet = table([]);
  const siteDevice = table([]);
  const gateways = table([{ id: GW, orgId: ORG, features: [] }]);
  let seq = 0;
  for (const t of [rooms, roomGroup, roomDivider, roomDraft, deployment]) {
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
    roomGroup,
    roomDivider,
    roomDraft,
    release,
    deployment,
    deploymentEvent,
    customDriver,
    customDriverVersion,
    roomBinding,
    credentialSet,
    siteDevice,
    gateway: gateways,
  } as unknown as GroupDeployDb;

  const groupId = await saveGroup(db, ORG, {
    name: 'Wing',
    siteId: SITE,
    roomIds: [A!, B!],
    dividers: [{ name: 'Wall', roomIds: [A!, B!] }],
  });
  await syncCombinedRooms(db, ORG, groupId);
  const combined = rooms.rows.find((r) => r.kind === 'combined')!;
  // The derived design still needs its cross-room wiring; give it a sound one for these tests.
  const draft = roomDraft.rows.find((d) => d.roomId === combined.id)!;
  draft.model = meeting();
  draft.revision = 1;
  return { db, groupId, rooms, release, deployment, roomDraft, combined };
}

describe('deploying a whole group', () => {
  it('plans a release and a deployment for every room, members before combined rooms', async () => {
    const w = await world();
    const { plan } = await planGroupDeploy(w.db, ORG, w.groupId);
    expect(plan.problems).toEqual([]);
    expect(plan.steps.map((s) => [s.name, s.kind, s.action, s.number])).toEqual([
      ['Room A', 'standard', 'publish_and_deploy', 1],
      ['Room B', 'standard', 'publish_and_deploy', 1],
      ['Room A + Room B', 'combined', 'publish_and_deploy', 1],
    ]);
    // Planning changes nothing.
    expect(w.release.rows).toHaveLength(0);
    expect(w.deployment.rows).toHaveLength(0);
  });

  it('publishes and deploys every room, and points each room at its release', async () => {
    const w = await world();
    const results = await deployGroup(w.db, ORG, w.groupId, ctx);
    expect(results.map((r) => [r.name, r.published, r.deployed])).toEqual([
      ['Room A', true, true],
      ['Room B', true, true],
      ['Room A + Room B', true, true],
    ]);
    expect(w.release.rows).toHaveLength(3);
    expect(w.deployment.rows.map((d) => d.roomId)).toEqual([A, B, w.combined.id]);
    for (const room of w.rooms.rows.filter((r) => r.groupId))
      expect(room.desiredReleaseId).toBe(w.release.rows.find((r) => r.roomId === room.id)!.id);
  });

  it('does not deploy anything if one room has a problem', async () => {
    const w = await world();
    // Room B has no design.
    w.roomDraft.rows.splice(
      w.roomDraft.rows.findIndex((d) => d.roomId === B),
      1,
    );
    await expect(deployGroup(w.db, ORG, w.groupId, ctx)).rejects.toThrow(/Room B: Design the room/);
    expect(w.release.rows).toHaveLength(0);
    expect(w.deployment.rows).toHaveLength(0);
    const { plan } = await planGroupDeploy(w.db, ORG, w.groupId);
    expect(plan.steps).toEqual([]);
  });

  it('names every problem, not just the first', async () => {
    const w = await world();
    for (const id of [A!, B!])
      w.roomDraft.rows.splice(
        w.roomDraft.rows.findIndex((d) => d.roomId === id),
        1,
      );
    const { plan } = await planGroupDeploy(w.db, ORG, w.groupId);
    expect(plan.problems).toHaveLength(2);
  });

  it('a second deploy with nothing changed sends nothing new', async () => {
    const w = await world();
    await deployGroup(w.db, ORG, w.groupId, ctx);
    // The gateway reports what it is running.
    for (const r of w.rooms.rows) if (r.desiredReleaseId) r.reportedReleaseId = r.desiredReleaseId;
    const results = await deployGroup(w.db, ORG, w.groupId, ctx);
    expect(results.every((r) => !r.published && !r.deployed)).toBe(true);
    expect(w.release.rows).toHaveLength(3);
    expect(w.deployment.rows).toHaveLength(3);
  });

  it('a changed design gets a new release; unchanged rooms are left alone', async () => {
    const w = await world();
    await deployGroup(w.db, ORG, w.groupId, ctx);
    for (const r of w.rooms.rows) if (r.desiredReleaseId) r.reportedReleaseId = r.desiredReleaseId;
    w.roomDraft.rows.find((d) => d.roomId === A)!.revision = 2;
    const results = await deployGroup(w.db, ORG, w.groupId, ctx);
    expect(results.map((r) => [r.name, r.published, r.deployed])).toEqual([
      ['Room A', true, true],
      ['Room B', false, false],
      ['Room A + Room B', false, false],
    ]);
    expect(w.release.rows.filter((r) => r.roomId === A).map((r) => r.number)).toEqual([1, 2]);
  });

  it('a room whose release was published but never reached the gateway is deployed again without a new release', async () => {
    const w = await world();
    await deployGroup(w.db, ORG, w.groupId, ctx);
    // Nothing reported: the gateway never confirmed.
    const results = await deployGroup(w.db, ORG, w.groupId, ctx);
    expect(results.every((r) => !r.published && r.deployed)).toBe(true);
    expect(w.release.rows).toHaveLength(3);
    expect(w.deployment.rows).toHaveLength(6);
  });

  it('refuses until the combined rooms exist', async () => {
    const w = await world();
    w.rooms.rows.splice(
      w.rooms.rows.findIndex((r) => r.id === w.combined.id),
      1,
    );
    const { plan } = await planGroupDeploy(w.db, ORG, w.groupId);
    expect(plan.problems.join()).toMatch(/Update combined rooms/);
  });

  it('refuses a room with no gateway', async () => {
    const w = await world({ gateway: null });
    const { plan } = await planGroupDeploy(w.db, ORG, w.groupId);
    expect(plan.problems.join()).toMatch(/not assigned to a gateway/);
  });

  it('cannot reach a group of another organisation', async () => {
    const w = await world();
    await expect(planGroupDeploy(w.db, 'someone-else', w.groupId)).rejects.toThrow(/not found/);
  });
});
