import { describe, expect, it } from 'vitest';
import type { PanelViewModel } from '@kestrel/model';
import {
  INTENT_TTL_MS,
  LIVE_MS,
  MAX_INTENTS_PER_10S,
  WATCH_TTL_MS,
  poll,
  portalIntent,
  portalSnapshot,
  watchedRooms,
  type ControlDb,
} from './control-service';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '11111111-1111-4111-8111-111111111112';
const GW = '99999999-9999-4999-8999-999999999991';
const GW2 = '99999999-9999-4999-8999-999999999992';
const ROOM = '33333333-3333-4333-8333-333333333331';
const ROOM2 = '33333333-3333-4333-8333-333333333332';
const NO_GW = '33333333-3333-4333-8333-333333333333';
const T0 = new Date('2026-09-24T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

const vm: PanelViewModel = {
  roomName: 'Boardroom',
  status: 'off',
  activities: [],
  volume: { available: true, level: 50, muted: false },
  message: null,
  prompt: null,
  warning: null,
};

function world() {
  const room = table([
    { id: ROOM, orgId: ORG, gatewayId: GW, name: 'Boardroom' },
    { id: ROOM2, orgId: ORG, gatewayId: GW2, name: 'Studio' },
    { id: NO_GW, orgId: ORG, gatewayId: null, name: 'Unassigned' },
  ]);
  const controlSession = table([]);
  const controlIntent = table([]);
  const auditLog = table([]);
  return {
    db: { room, controlSession, controlIntent, auditLog } as unknown as ControlDb,
    controlSession,
    controlIntent,
    auditLog,
  };
}
const gw = { id: GW, orgId: ORG };
const start = { type: 'activity.start', activityId: 'present' };
const bump = { type: 'volume.bump', delta: 1 };
const send = (
  w: ReturnType<typeof world>,
  intent: unknown,
  now: Date,
  roomId = ROOM,
  orgId = ORG,
) => portalIntent(w.db, { orgId, roomId, intent, by: 'u1' }, now);
const intentsOf = (res: { body: unknown }) =>
  (res.body as { intents: { roomId: string; intent: { type: string } }[] }).intents;

describe('portal side', () => {
  it('opens a session when a control page asks for a room, and shows nothing until the gateway reports', async () => {
    const w = world();
    const snap = await portalSnapshot(w.db, { orgId: ORG, roomId: ROOM }, T0);
    expect(snap).toEqual({ hasGateway: true, vm: null, live: false });
    expect(w.controlSession.rows).toHaveLength(1);
    expect(await watchedRooms(w.db, GW, at(1000))).toEqual([ROOM]);
  });

  it('never shows or controls another organisation’s room', async () => {
    const w = world();
    expect(await portalSnapshot(w.db, { orgId: OTHER_ORG, roomId: ROOM }, T0)).toBeNull();
    expect(await send(w, start, T0, ROOM, OTHER_ORG)).toEqual({
      ok: false,
      error: 'Room not found',
    });
    expect(w.controlIntent.rows).toHaveLength(0);
  });

  it('stops asking the gateway to watch a room once the page has been closed', async () => {
    const w = world();
    await portalSnapshot(w.db, { orgId: ORG, roomId: ROOM }, T0);
    expect(await watchedRooms(w.db, GW, at(WATCH_TTL_MS - 1))).toEqual([ROOM]);
    expect(await watchedRooms(w.db, GW, at(WATCH_TTL_MS + 1))).toEqual([]);
  });

  it('only accepts real panel intents for rooms that run on a gateway', async () => {
    const w = world();
    for (const intent of [
      { type: 'format_disk' },
      { type: 'volume.set', level: 900 },
      'nope',
      null,
    ])
      expect((await send(w, intent, T0)).ok).toBe(false);
    expect((await send(w, start, T0, NO_GW)).ok).toBe(false);
    expect(w.controlIntent.rows).toHaveLength(0);
  });

  it('queues an intent for the room’s gateway, keeps the session alive, and audits starts but not volume nudges', async () => {
    const w = world();
    await send(w, start, T0);
    await send(w, { type: 'volume.bump', delta: 5 }, T0);
    expect(w.controlIntent.rows.map((r) => r.gatewayId)).toEqual([GW, GW]);
    expect(w.controlSession.rows).toHaveLength(1);
    expect(w.auditLog.rows).toHaveLength(1);
    expect(w.auditLog.rows[0]).toMatchObject({
      action: 'control.intent',
      actorId: 'u1',
      orgId: ORG,
    });
  });

  it('limits how fast intents can be queued', async () => {
    const w = world();
    for (let i = 0; i < MAX_INTENTS_PER_10S; i++) expect((await send(w, bump, T0)).ok).toBe(true);
    expect((await send(w, bump, T0)).ok).toBe(false);
    expect((await send(w, bump, at(11_000))).ok).toBe(true);
  });
});

describe('gateway poll', () => {
  it('stores the panel state a gateway sends and marks it live', async () => {
    const w = world();
    await portalSnapshot(w.db, { orgId: ORG, roomId: ROOM }, T0);
    const res = await poll(w.db, gw, { protocol: 1, panels: [{ roomId: ROOM, vm }] }, at(500));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ watch: [ROOM], intents: [] });
    const snap = await portalSnapshot(w.db, { orgId: ORG, roomId: ROOM }, at(1000));
    expect(snap).toMatchObject({ live: true, vm: { roomName: 'Boardroom' } });
    // Goes stale if the gateway stops answering.
    expect(
      (await portalSnapshot(w.db, { orgId: ORG, roomId: ROOM }, at(500 + LIVE_MS + 1)))!.live,
    ).toBe(false);
  });

  it('ignores state a gateway sends for a room that is not its own', async () => {
    const w = world();
    await portalSnapshot(w.db, { orgId: ORG, roomId: ROOM2 }, T0);
    await poll(w.db, gw, { protocol: 1, panels: [{ roomId: ROOM2, vm }] }, at(500));
    expect(w.controlSession.rows[0]!.snapshot).toBeUndefined();
  });

  it('rejects a malformed poll and a state that is not a panel view', async () => {
    const w = world();
    expect((await poll(w.db, gw, { nonsense: 1 }, T0)).status).toBe(400);
    const bad = { protocol: 1, panels: [{ roomId: ROOM, vm: { hacked: true } }] };
    expect((await poll(w.db, gw, bad, T0)).status).toBe(400);
  });

  it('hands each intent to the gateway once, in order, and only its own', async () => {
    const w = world();
    await send(w, start, T0);
    await send(w, { type: 'mute.set', muted: true }, at(10));
    await send(w, start, at(20), ROOM2);
    const first = intentsOf(await poll(w.db, gw, { protocol: 1 }, at(100)));
    expect(first.map((i) => i.intent.type)).toEqual(['activity.start', 'mute.set']);
    expect(first.every((i) => i.roomId === ROOM)).toBe(true);
    expect(intentsOf(await poll(w.db, gw, { protocol: 1 }, at(200)))).toEqual([]);
    expect(
      intentsOf(await poll(w.db, { id: GW2, orgId: ORG }, { protocol: 1 }, at(300))),
    ).toHaveLength(1);
  });

  it('drops intents nobody collected in time instead of running them late', async () => {
    const w = world();
    await send(w, { type: 'volume.bump', delta: 10 }, T0);
    expect(intentsOf(await poll(w.db, gw, { protocol: 1 }, at(INTENT_TTL_MS + 1)))).toEqual([]);
    expect(w.controlIntent.rows[0]!.deliveredAt).toBeTruthy();
  });
});
