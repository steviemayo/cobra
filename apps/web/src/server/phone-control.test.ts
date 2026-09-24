import { describe, expect, it } from 'vitest';
import { roomAccessSecret, signAccess } from '@kestrel/crypto';
import { SESSION_TTL_SECONDS, joinRoom, phoneIntent, phoneState, type PhoneDb } from './phone-control';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const ROOM = '33333333-3333-4333-8333-333333333331';
const ROOM2 = '33333333-3333-4333-8333-333333333332';
const GW = '99999999-9999-4999-8999-999999999991';
const KEY = 'master-key-for-tests';
const NOW = new Date('2026-09-25T10:00:00Z');
const nowSec = Math.floor(NOW.getTime() / 1000);
const later = (sec: number) => new Date(NOW.getTime() + sec * 1000);

function world() {
  const controlIntent = table([]);
  const db = {
    room: table([
      { id: ROOM, orgId: ORG, gatewayId: GW, name: 'Boardroom', panel: null },
      { id: ROOM2, orgId: ORG, gatewayId: GW, name: 'Studio', panel: null },
    ]),
    org: table([{ id: ORG, branding: null }]),
    controlSession: table([]),
    controlIntent,
    auditLog: table([]),
  } as unknown as PhoneDb;
  return { db, controlIntent };
}
const join = (room = ROOM, exp = nowSec + 600, key = KEY) => signAccess(roomAccessSecret(key, room), 'join', room, exp);

describe('joining a room from a phone', () => {
  it('swaps a fresh QR link for a two hour session', async () => {
    const r = await joinRoom(world().db, { joinToken: join() }, KEY, NOW);
    expect(r.ok && r.value.roomName).toBe('Boardroom');
    expect(r.ok && r.value.expiresAt).toBe(later(SESSION_TTL_SECONDS).toISOString());
  });

  it('refuses expired, forged, wrong-kind and malformed links', async () => {
    const { db } = world();
    const status = async (joinToken: string, key: string | undefined) => {
      const r = await joinRoom(db, { joinToken }, key, NOW);
      return r.ok ? 200 : r.status;
    };
    expect(await status(join(ROOM, nowSec - 1), KEY)).toBe(401);
    expect(await status(join(ROOM, nowSec + 600, 'another-key'), KEY)).toBe(401);
    expect(await status(signAccess(roomAccessSecret(KEY, ROOM), 'session', ROOM, nowSec + 600), KEY)).toBe(401);
    expect(await status('junk', KEY)).toBe(400);
    expect(await status(join(), undefined)).toBe(503);
  });

  it('cannot use a link made for one room to reach another', async () => {
    const forged = join(ROOM).replace(ROOM, ROOM2);
    const r = await joinRoom(world().db, { joinToken: forged }, KEY, NOW);
    expect(r.ok).toBe(false);
  });
});

describe('controlling a room from a phone', () => {
  const session = async (w = world()) => {
    const r = await joinRoom(w.db, { joinToken: join() }, KEY, NOW);
    if (!r.ok) throw new Error('join failed');
    return { ...w, token: r.value.session };
  };

  it('reads the room’s panel state and queues intents for its gateway', async () => {
    const { db, token, controlIntent } = await session();
    const state = await phoneState(db, token, KEY, NOW);
    expect(state.ok && state.value).toMatchObject({ hasGateway: true, vm: null, live: false });
    const res = await phoneIntent(db, { session: token, intent: { type: 'volume.bump', delta: 5 } }, KEY, NOW);
    expect(res.ok).toBe(true);
    expect(controlIntent.rows).toHaveLength(1);
    expect(controlIntent.rows[0]).toMatchObject({ roomId: ROOM, orgId: ORG, gatewayId: GW, createdBy: null });
  });

  it('rejects intents a panel could not send, and sessions that have run out', async () => {
    const { db, token } = await session();
    const bad = await phoneIntent(db, { session: token, intent: { type: 'volume.set', level: 9999 } }, KEY, NOW);
    expect(bad).toMatchObject({ ok: false, status: 400 });
    const old = await phoneState(db, token, KEY, later(SESSION_TTL_SECONDS + 1));
    expect(old).toMatchObject({ ok: false, status: 401 });
    const join1 = await phoneIntent(db, { session: join(), intent: { type: 'volume.bump', delta: 1 } }, KEY, NOW);
    expect(join1).toMatchObject({ ok: false, status: 401 });
  });

  it('is rate limited like the portal', async () => {
    const { db, token } = await session();
    let last: Awaited<ReturnType<typeof phoneIntent>> | null = null;
    for (let i = 0; i < 45; i++)
      last = await phoneIntent(db, { session: token, intent: { type: 'volume.bump', delta: 1 } }, KEY, NOW);
    expect(last).toMatchObject({ ok: false, status: 429 });
  });
});
