import { parseAccess, roomAccessSecret, signAccess, verifyAccess } from '@kestrel/crypto';
import { PanelIntent } from '@kestrel/model';
import { effectivePanel, readPanel } from './panel-settings';
import { orgPanelBranding, type BrandDb } from './provider-brand';
import { portalIntent, portalSnapshot, type ControlDb } from './control-service';

// Controlling a room from a phone. The wall panel shows a QR code holding a "join" link the gateway
// signed a few minutes ago; scanning it swaps that link for a 45 minute "session" token, and the
// phone then talks to the room through the same control path as the portal, except for the
// actuator intents (see ACTUATOR_ONLY_FROM_PANEL in control-service.ts): a session made from a
// photo of a QR code is a weaker credential than being in the room, so it cannot move a wall or a
// lift. Both tokens are signed with a secret derived for that room, so nothing is stored and a
// token for one room opens no other; there is no way to revoke one before it expires.

export const SESSION_TTL_SECONDS = 45 * 60;

export type PhoneDb = ControlDb & BrandDb;
export type PhoneResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const bad = (status: number, error: string): { ok: false; status: number; error: string } => ({
  ok: false,
  status,
  error,
});
const EXPIRED = 'This link has expired. Scan the code on the room’s screen again.';

export async function joinRoom(
  db: PhoneDb,
  input: { joinToken: string },
  masterKey: string | undefined,
  now = new Date(),
): Promise<PhoneResult<{ session: string; expiresAt: string; roomName: string }>> {
  if (!masterKey) return bad(503, 'Phone control isn’t set up on this Kestrel server');
  const parsed = parseAccess(input.joinToken);
  if (!parsed) return bad(400, 'That isn’t a room link');
  const nowSec = Math.floor(now.getTime() / 1000);
  const secret = roomAccessSecret(masterKey, parsed.roomId);
  if (!verifyAccess(secret, 'join', input.joinToken, nowSec)) return bad(401, EXPIRED);
  const room = await db.room.findFirst({ where: { id: parsed.roomId } });
  if (!room) return bad(404, 'Room not found');
  const exp = nowSec + SESSION_TTL_SECONDS;
  return {
    ok: true,
    value: {
      session: signAccess(secret, 'session', room.id, exp),
      expiresAt: new Date(exp * 1000).toISOString(),
      roomName: room.name,
    },
  };
}

async function roomFor(db: PhoneDb, session: string, masterKey: string | undefined, now: Date) {
  if (!masterKey) return bad(503, 'Phone control isn’t set up on this Kestrel server');
  const parsed = parseAccess(session);
  if (
    !parsed ||
    !verifyAccess(roomAccessSecret(masterKey, parsed.roomId), 'session', session, Math.floor(now.getTime() / 1000))
  )
    return bad(401, EXPIRED);
  const room = await db.room.findFirst({ where: { id: parsed.roomId } });
  return room ? ({ ok: true, room } as const) : bad(404, 'Room not found');
}

/** The room's current panel, in the same shape the portal's control page uses. */
export async function phoneState(db: PhoneDb, session: string, masterKey: string | undefined, now = new Date()) {
  const r = await roomFor(db, session, masterKey, now);
  if (!r.ok) return r;
  const snap = await portalSnapshot(db, { orgId: r.room.orgId, roomId: r.room.id }, now);
  if (!snap) return bad(404, 'Room not found');
  const org = await db.org.findFirst({ where: { id: r.room.orgId }, select: { branding: true } });
  const { branding } = effectivePanel(
    readPanel(r.room.panel),
    await orgPanelBranding(db, r.room.orgId, org?.branding),
  );
  return { ok: true, value: { ...snap, branding } } as const;
}

export async function phoneIntent(
  db: PhoneDb,
  input: { session: string; intent: unknown },
  masterKey: string | undefined,
  now = new Date(),
): Promise<PhoneResult<{ ok: true }>> {
  const r = await roomFor(db, input.session, masterKey, now);
  if (!r.ok) return r;
  const intent = PanelIntent.safeParse(input.intent);
  if (!intent.success) return bad(400, 'That isn’t something a panel can do');
  const res = await portalIntent(db, { orgId: r.room.orgId, roomId: r.room.id, intent: intent.data, by: null }, now);
  return res.ok ? { ok: true, value: { ok: true } } : bad(res.error.startsWith('Slow') ? 429 : 400, res.error);
}
