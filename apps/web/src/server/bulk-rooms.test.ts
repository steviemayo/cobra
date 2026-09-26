import { describe, expect, it } from 'vitest';
import { RoomModel, bulkColumns, type BulkRow, type Device } from '@kestrel/model';
import { applyBulk, planBulk, type BulkDb, type BulkInput } from './bulk-rooms';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222221';
const OTHER_SITE = '22222222-2222-4222-8222-222222222222';
const GW = '99999999-9999-4999-8999-999999999991';
const SET = '77777777-7777-4777-8777-777777777771';

const proj: Device = {
  id: 'proj',
  name: 'Projector',
  category: 'projector',
  ports: [],
  extraCapabilities: [],
  control: { kind: 'generic', protocol: 'pjlink' },
  settings: {},
};
const model = RoomModel.parse({ roomType: 'meeting', devices: [proj] });
const host = bulkColumns(model).columns.find((c) => c.key === 'host')!;
const row = (name: string, address?: string): BulkRow => ({ name, values: address ? { [host.id]: address } : {} });

function world(rooms: Record<string, unknown>[] = []) {
  const room = table(rooms);
  const roomDraft = table([]);
  const roomBinding = table([]);
  const credentialSet = table([{ id: SET, orgId: ORG, name: 'Site login' }]);
  const siteDevice = table([]);
  const gateway = table([
    { id: GW, orgId: ORG, siteId: SITE },
    { id: 'other-gw', orgId: ORG, siteId: OTHER_SITE },
  ]);
  const db = { room, roomDraft, roomBinding, credentialSet, siteDevice, gateway } as unknown as BulkDb;
  const input = (rows: BulkRow[], over: Partial<BulkInput> = {}): BulkInput => ({
    orgId: ORG,
    siteId: SITE,
    gatewayId: null,
    model,
    custom: {},
    rows,
    credentialSets: {},
    maxRooms: null,
    userId: 'u1',
    ...over,
  });
  return { db, room, roomDraft, roomBinding, input };
}

const existing = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  orgId: ORG,
  siteId: SITE,
  name,
  kind: 'standard',
  ...extra,
});

describe('planning', () => {
  it('says every new name is a create, and changes nothing', async () => {
    const w = world();
    const plan = await planBulk(w.db, w.input([row('A', '10.0.0.1'), row('B', '10.0.0.2')]));
    expect(plan).toMatchObject({ ok: true, creates: 2, updates: 0, problems: [] });
    expect(w.room.rows).toHaveLength(0);
  });

  it('stops on a grid error, and still allows a warning', async () => {
    const w = world();
    expect((await planBulk(w.db, w.input([row('A', '10.0.0.1'), row('A', '10.0.0.2')]))).ok).toBe(false);
    const warned = await planBulk(w.db, w.input([row('A')]));
    expect(warned.ok).toBe(true);
    expect(warned.rows[0]!.issues[0]).toMatchObject({ level: 'warning' });
  });

  it('matches a room already at the site by name, ignoring case, and says when nothing would change', async () => {
    const w = world([existing('r1', 'Room A')]);
    await w.roomDraft.create({ data: { orgId: ORG, roomId: 'r1', model } });
    const plan = await planBulk(w.db, w.input([row('room a', '10.0.0.1'), row('Room B', '10.0.0.2')]));
    expect(plan.rows.map((r) => r.action)).toEqual(['update', 'create']);
    await w.roomBinding.create({ data: { orgId: ORG, roomId: 'r1', version: 1, values: { proj: { host: '10.0.0.1' } }, sealed: null, credentialSets: {} } });
    expect((await planBulk(w.db, w.input([row('Room A', '10.0.0.1')]))).rows[0]!.action).toBe('unchanged');
  });

  it('does not match a room at another site or a combined room', async () => {
    const w = world([existing('r1', 'Room A', { siteId: OTHER_SITE }), existing('r2', 'Room B', { kind: 'combined' })]);
    const plan = await planBulk(w.db, w.input([row('Room A', '10.0.0.1'), row('Room B', '10.0.0.2')]));
    expect(plan.rows.map((r) => r.action)).toEqual(['create', 'create']);
  });

  it('refuses to update a room with no design, or two rooms with the same name', async () => {
    const w = world([existing('r1', 'Room A'), existing('r2', 'Dup'), existing('r3', 'dup')]);
    const plan = await planBulk(w.db, w.input([row('Room A', '10.0.0.1'), row('Dup', '10.0.0.2')]));
    expect(plan.rows.map((r) => r.action)).toEqual(['error', 'error']);
    expect(plan.rows[0]!.issues[0]!.message).toMatch(/no design/);
    expect(plan.rows[1]!.issues[0]!.message).toMatch(/More than one room/);
  });

  it('refuses to update a room whose design lacks the template’s device', async () => {
    const w = world([existing('r1', 'Room A')]);
    await w.roomDraft.create({ data: { orgId: ORG, roomId: 'r1', model: RoomModel.parse({ roomType: 'meeting', devices: [] }) } });
    const plan = await planBulk(w.db, w.input([row('Room A', '10.0.0.1')]));
    expect(plan.rows[0]!.issues.at(-1)!.message).toMatch(/different design/);
  });

  it('stops when the plan’s room limit would be passed, counting only standard rooms', async () => {
    const w = world([existing('r1', 'Old'), existing('r2', 'Combined', { kind: 'combined' })]);
    const over = await planBulk(w.db, w.input([row('A', '10.0.0.1'), row('B', '10.0.0.2')], { maxRooms: 2 }));
    expect(over.ok).toBe(false);
    expect(over.problems[0]).toMatch(/plan includes 2 rooms/);
    expect((await planBulk(w.db, w.input([row('A', '10.0.0.1')], { maxRooms: 2 }))).ok).toBe(true);
  });

  it('only updating rooms is fine at the limit', async () => {
    const w = world([existing('r1', 'Old')]);
    await w.roomDraft.create({ data: { orgId: ORG, roomId: 'r1', model } });
    expect((await planBulk(w.db, w.input([row('Old', '10.0.0.1')], { maxRooms: 1 }))).ok).toBe(true);
  });

  it('checks the gateway is at the site and the shared logins exist', async () => {
    const w = world();
    expect((await planBulk(w.db, w.input([row('A', '10.0.0.1')], { gatewayId: 'other-gw' }))).problems).toEqual([
      'A room can only use a gateway at its own site',
    ]);
    expect((await planBulk(w.db, w.input([row('A', '10.0.0.1')], { gatewayId: 'nope' }))).problems).toEqual(['That gateway does not exist']);
    expect((await planBulk(w.db, w.input([row('A', '10.0.0.1')], { credentialSets: { proj: 'not-there' } }))).problems).toEqual([
      'One of the shared logins chosen does not exist',
    ]);
    expect((await planBulk(w.db, w.input([row('A', '10.0.0.1')], { credentialSets: { nope: SET } }))).problems).toEqual([
      'A shared login was chosen for a device that does not use one',
    ]);
  });
});

describe('applying', () => {
  it('creates each room with the template’s design and its own addresses, at one bindings version each', async () => {
    const w = world();
    const res = await applyBulk(w.db, w.input([row('A', '10.0.0.1'), row('B', '10.0.0.2')], { gatewayId: GW, credentialSets: { proj: SET } }));
    expect(res.ok && res.created.map((c) => c.name)).toEqual(['A', 'B']);
    expect(w.room.rows.map((r) => [r.name, r.type, r.siteId, r.gatewayId])).toEqual([
      ['A', 'meeting', SITE, GW],
      ['B', 'meeting', SITE, GW],
    ]);
    expect(w.roomDraft.rows).toHaveLength(2);
    expect(w.roomDraft.rows[0]!.model).toEqual(model);
    expect(w.roomBinding.rows.map((b) => [b.version, b.values, b.credentialSets])).toEqual([
      [1, { proj: { host: '10.0.0.1' } }, { proj: SET }],
      [1, { proj: { host: '10.0.0.2' } }, { proj: SET }],
    ]);
  });

  it('writes nothing at all when any row is wrong', async () => {
    const w = world();
    const res = await applyBulk(w.db, w.input([row('A', '10.0.0.1'), row('', '10.0.0.2')]));
    expect(res.ok).toBe(false);
    expect(w.room.rows).toHaveLength(0);
    expect(w.roomBinding.rows).toHaveLength(0);
  });

  it('updates a room’s addresses by name, keeping the rest, and does not touch its gateway or design', async () => {
    const w = world([existing('r1', 'Room A', { gatewayId: 'kept' })]);
    await w.roomDraft.create({ data: { orgId: ORG, roomId: 'r1', model } });
    await w.roomBinding.create({
      data: { orgId: ORG, roomId: 'r1', version: 3, values: { proj: { host: '10.0.0.1', port: 4352 } }, sealed: null, credentialSets: {} },
    });
    const res = await applyBulk(w.db, w.input([row('Room A', '10.0.0.9')], { gatewayId: GW }));
    expect(res.ok && res.updated.map((u) => u.name)).toEqual(['Room A']);
    expect(w.room.rows[0]!.gatewayId).toBe('kept');
    expect(w.roomBinding.rows[0]).toMatchObject({ version: 4, values: { proj: { host: '10.0.0.9', port: 4352 } } });
    expect(w.roomDraft.rows).toHaveLength(1);
  });

  it('leaves a blank cell alone on an update, and writes nothing when nothing differs', async () => {
    const w = world([existing('r1', 'Room A')]);
    await w.roomDraft.create({ data: { orgId: ORG, roomId: 'r1', model } });
    await w.roomBinding.create({ data: { orgId: ORG, roomId: 'r1', version: 3, values: { proj: { host: '10.0.0.1' } }, sealed: null, credentialSets: {} } });
    const res = await applyBulk(w.db, w.input([row('Room A')]));
    expect(res.ok && res.updated).toEqual([]);
    expect(w.roomBinding.rows[0]!.version).toBe(3);
  });

  it('stores a port as a number', async () => {
    const w = world();
    const port = bulkColumns(model).columns.find((c) => c.key === 'port')!;
    await applyBulk(w.db, w.input([{ name: 'A', values: { [host.id]: '10.0.0.1', [port.id]: '4352' } }]));
    expect(w.roomBinding.rows[0]!.values).toEqual({ proj: { host: '10.0.0.1', port: 4352 } });
  });
});
