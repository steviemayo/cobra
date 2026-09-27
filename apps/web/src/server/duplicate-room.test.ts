import { describe, expect, it } from 'vitest';
import { RoomModel, type Device } from '@kestrel/model';
import { duplicateRoom, DuplicateRoomError, type DuplicateDb, type DuplicateInput } from './duplicate-room';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222221';
const OTHER_SITE = '22222222-2222-4222-8222-222222222222';
const GW = '99999999-9999-4999-8999-999999999991';
const SET = '77777777-7777-4777-8777-777777777771';
const SOURCE = '33333333-3333-4333-8333-333333333331';

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

function world(rooms: Record<string, unknown>[] = []) {
  const room = table([
    { id: SOURCE, orgId: ORG, siteId: SITE, name: 'Boardroom', type: 'meeting', kind: 'standard', gatewayId: GW },
    ...rooms,
  ]);
  const roomDraft = table([]);
  const roomBinding = table([]);
  const credentialSet = table([{ id: SET, orgId: ORG, name: 'Site login' }]);
  const siteDevice = table([]);
  const db = { room, roomDraft, roomBinding, credentialSet, siteDevice } as unknown as DuplicateDb;
  const input = (name: string, over: Partial<DuplicateInput> = {}): DuplicateInput => ({
    orgId: ORG,
    source: { id: SOURCE, siteId: SITE, type: 'meeting', gatewayId: GW },
    name,
    model,
    userId: 'u1',
    ...over,
  });
  return { db, room, roomDraft, roomBinding, input };
}

describe('duplicating a room', () => {
  it('makes a room at the same site, on the same gateway, with the same design', async () => {
    const w = world();
    const copy = await duplicateRoom(w.db, w.input('Boardroom 2'));
    const row = w.room.rows.find((r) => r.id === copy.id)!;
    expect(row).toMatchObject({ orgId: ORG, siteId: SITE, name: 'Boardroom 2', type: 'meeting', gatewayId: GW });
    expect(w.roomDraft.rows).toHaveLength(1);
    expect(w.roomDraft.rows[0]).toMatchObject({ orgId: ORG, roomId: copy.id, model });
    // The original is untouched.
    expect(w.room.rows.find((r) => r.id === SOURCE)!.name).toBe('Boardroom');
  });

  it('leaves the gateway empty when the original has none', async () => {
    const w = world();
    const copy = await duplicateRoom(w.db, w.input('Boardroom 2', { source: { id: SOURCE, siteId: SITE, type: 'meeting', gatewayId: null } }));
    expect(w.room.rows.find((r) => r.id === copy.id)!.gatewayId).toBeUndefined();
  });

  it('trims the name', async () => {
    const w = world();
    const copy = await duplicateRoom(w.db, w.input('  Boardroom 2  '));
    expect(copy.name).toBe('Boardroom 2');
  });

  it('refuses a name already used at the site, ignoring case', async () => {
    const w = world();
    await expect(duplicateRoom(w.db, w.input('boardroom'))).rejects.toThrow(DuplicateRoomError);
    expect(w.room.rows).toHaveLength(1);
    expect(w.roomDraft.rows).toHaveLength(0);
  });

  it('allows a name used at another site, or by a combined room', async () => {
    const w = world([
      { id: 'r2', orgId: ORG, siteId: OTHER_SITE, name: 'Annex', type: 'meeting', kind: 'standard' },
      { id: 'r3', orgId: ORG, siteId: SITE, name: 'Wing', type: 'meeting', kind: 'combined' },
    ]);
    await expect(duplicateRoom(w.db, w.input('Annex'))).resolves.toMatchObject({ name: 'Annex' });
    await expect(duplicateRoom(w.db, w.input('Wing'))).resolves.toMatchObject({ name: 'Wing' });
  });

  it('copies the shared logins chosen for the original, but no addresses', async () => {
    const w = world();
    w.roomBinding.rows.push({
      id: 'b1',
      orgId: ORG,
      roomId: SOURCE,
      version: 3,
      values: { proj: { host: '10.0.0.5' } },
      credentialSets: { proj: SET },
    });
    const copy = await duplicateRoom(w.db, w.input('Boardroom 2'));
    const made = w.roomBinding.rows.find((b) => b.roomId === copy.id)!;
    expect(made.credentialSets).toEqual({ proj: SET });
    expect(JSON.stringify(made.values ?? {})).not.toContain('10.0.0.5');
  });

  it('can make a staging room, which is marked so it is not billed', async () => {
    const w = world();
    const copy = await duplicateRoom(w.db, w.input('Boardroom (staging)', { kind: 'staging' }));
    expect(w.room.rows.find((r) => r.id === copy.id)!.kind).toBe('staging');
    const normal = await duplicateRoom(w.db, w.input('Boardroom 2'));
    expect(w.room.rows.find((r) => r.id === normal.id)!.kind).toBeUndefined();
  });

  it('writes no bindings when the original has no shared logins', async () => {
    const w = world();
    const copy = await duplicateRoom(w.db, w.input('Boardroom 2'));
    expect(w.roomBinding.rows.filter((b) => b.roomId === copy.id)).toHaveLength(0);
  });
});
