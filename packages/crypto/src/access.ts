import { createHmac, timingSafeEqual } from 'node:crypto';

// Short-lived access tokens for controlling a room from a phone. The gateway mints a "join" token
// (valid for a few minutes) for the QR code on the wall panel; the cloud swaps a valid join token
// for a longer "session" token. Both are an HMAC under a secret only the cloud and that room's
// gateway know, so nobody can mint one from a photo of an old QR code, and a token for one room is
// useless for any other.
export type AccessKind = 'join' | 'session';

const mac = (secret: string, kind: AccessKind, roomId: string, exp: number) =>
  createHmac('sha256', secret).update(`${kind}|${roomId}|${exp}`).digest('base64url');

/** A token for a room that stops working at `expiresAtSec` (seconds since 1970). */
export function signAccess(secret: string, kind: AccessKind, roomId: string, expiresAtSec: number): string {
  return `${roomId}.${expiresAtSec}.${mac(secret, kind, roomId, expiresAtSec)}`;
}

/** Reads a token's room and expiry without trusting it. Verify with `verifyAccess` before use. */
export function parseAccess(token: string): { roomId: string; exp: number } | null {
  const m = /^([0-9a-f-]{36})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/i.exec(token);
  return m ? { roomId: m[1]!.toLowerCase(), exp: Number(m[2]) } : null;
}

/** True only for a token of this kind, for this room, signed with this secret, not yet expired. */
export function verifyAccess(secret: string, kind: AccessKind, token: string, nowSec = Math.floor(Date.now() / 1000)): { roomId: string; exp: number } | null {
  const p = parseAccess(token);
  if (!p || p.exp <= nowSec) return null;
  const given = Buffer.from(token.split('.')[2]!);
  const want = Buffer.from(mac(secret, kind, p.roomId, p.exp));
  return given.length === want.length && timingSafeEqual(given, want) ? p : null;
}

/** The secret a room's phone links are signed with, derived so it needs no storage of its own. */
export function roomAccessSecret(masterKey: string, roomId: string): string {
  return createHmac('sha256', masterKey).update(`phone-access|${roomId}`).digest('base64url');
}
