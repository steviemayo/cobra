import { describe, expect, it } from 'vitest';
import { ConfigResponse, HeartbeatRequest } from '@kestrel/model';
import { groupsForGateway, recordDividers, type GatewayGroupDb } from './gateway-groups';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const GW = '99999999-9999-4999-8999-999999999991';
const GW2 = '99999999-9999-4999-8999-999999999992';
const G = '44444444-4444-4444-8444-444444444441';
const [A, B, C, AB, ELSEWHERE] = Array.from(
  { length: 5 },
  (_, i) => `33333333-3333-4333-8333-33333333333${i + 1}`,
);
const [D1, D2] = ['55555555-5555-4555-8555-555555555551', '55555555-5555-4555-8555-555555555552'];

function world(over: { abGateway?: string; cGateway?: string } = {}) {
  const room = (id: string, gatewayId: string, extra: Record<string, unknown> = {}) => ({
    id,
    orgId: ORG,
    name: id.slice(-1),
    gatewayId,
    groupId: G,
    kind: 'standard',
    memberRoomIds: [],
    ...extra,
  });
  const rooms = table([
    room(A!, GW),
    room(B!, GW),
    room(C!, over.cGateway ?? GW),
    room(AB!, over.abGateway ?? GW, { kind: 'combined', memberRoomIds: [A, B] }),
    room(ELSEWHERE!, GW2, { groupId: null }),
  ]);
  const roomGroup = table([{ id: G, orgId: ORG, name: 'Wing' }]);
  const roomDivider = table([
    {
      id: D1,
      groupId: G,
      name: 'Wall 1',
      roomIds: [A, B],
      onOpen: 'on',
      onClose: 'restore',
      open: false,
      createdAt: new Date(1),
    },
    // A row from before the columns existed reads as the defaults.
    { id: D2, groupId: G, name: 'Wall 2', roomIds: [B, C], createdAt: new Date(2) },
  ]);
  return {
    db: { room: rooms, roomGroup, roomDivider } as unknown as GatewayGroupDb,
    roomDivider,
  };
}

const gw = { id: GW, orgId: ORG };

describe('the groups a gateway runs', () => {
  it('sends the rooms, the walls with their open and close actions, and the combined rooms', async () => {
    const [group] = await groupsForGateway(world().db, gw);
    expect(group).toMatchObject({ id: G, name: 'Wing', roomIds: [A, B, C] });
    expect(group!.dividers).toEqual([
      { id: D1, name: 'Wall 1', roomIds: [A, B], onOpen: 'on', onClose: 'restore' },
      { id: D2, name: 'Wall 2', roomIds: [B, C], onOpen: 'follow', onClose: 'off' },
    ]);
    expect(group!.combined).toEqual([{ roomId: AB, memberRoomIds: [A, B] }]);
  });

  it('is what the protocol accepts', async () => {
    const groups = await groupsForGateway(world().db, gw);
    const parsed = ConfigResponse.safeParse({
      gatewayId: GW,
      configVersion: 'x',
      rooms: [],
      publicKeys: [],
      groups,
    });
    expect(parsed.success).toBe(true);
  });

  it('leaves out a group whose rooms are not all on this gateway', async () => {
    expect(await groupsForGateway(world({ cGateway: GW2 }).db, gw)).toEqual([]);
  });

  it('leaves out a combined room that is on another gateway', async () => {
    const [group] = await groupsForGateway(world({ abGateway: GW2 }).db, gw);
    expect(group!.combined).toEqual([]);
  });

  it('sends nothing to a gateway with no grouped rooms, or another organisation', async () => {
    expect(await groupsForGateway(world().db, { id: GW2, orgId: ORG })).toEqual([]);
    expect(await groupsForGateway(world().db, { id: GW, orgId: 'other' })).toEqual([]);
  });
});

describe('walls reported by a gateway', () => {
  it('records which walls are open', async () => {
    const w = world();
    await recordDividers(w.db, gw, [{ id: D1!, open: true }]);
    expect(w.roomDivider.rows.find((r) => r.id === D1)!.open).toBe(true);
    await recordDividers(w.db, gw, [{ id: D1!, open: false }]);
    expect(w.roomDivider.rows.find((r) => r.id === D1)!.open).toBe(false);
  });

  it("ignores walls that are not in this gateway's groups", async () => {
    const w = world();
    await recordDividers(w.db, { id: GW2, orgId: ORG }, [{ id: D1!, open: true }]);
    expect(w.roomDivider.rows.find((r) => r.id === D1)!.open).toBe(false);
  });

  it('an older gateway that reports nothing about walls still sends a valid heartbeat', () => {
    const r = HeartbeatRequest.safeParse({
      protocol: 1,
      gatewayVersion: '0.1.0',
      uptimeSeconds: 1,
      configVersion: null,
      rooms: [],
    });
    expect(r.success && r.data.dividers).toEqual([]);
  });
});
