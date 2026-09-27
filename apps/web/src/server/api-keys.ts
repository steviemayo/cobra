import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@kestrel/db';
import { generateSecret, hashSecret, secretMatches } from '@kestrel/crypto';

// API keys for the public API. A key looks like kst_1a2b3c4d_<secret>: the short part after kst_ finds
// the key, and only a hash of the secret is stored, so a leaked database does not leak working keys.
// The key is shown once, when it is made. These functions take the database as a parameter so they
// can be tested without one.
export type ApiKeyDb = Pick<PrismaClient, 'apiKey'>;

export const MAX_KEYS_PER_ORG = 10;
/** A key is recorded as used at most this often, so reading does not mean writing every time. */
export const LAST_USED_EVERY_MS = 60_000;
/** Requests one key may make in a minute. */
export const REQUESTS_PER_MINUTE = 120;

const KEY = /^Bearer (kst_[0-9a-f]{8})_([A-Za-z0-9_-]{20,120})$/;

export class ApiKeyError extends Error {}

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export async function createApiKey(
  db: ApiKeyDb,
  input: { orgId: string; name: string; userId: string | null; expiresAt: Date | null },
  now = new Date(),
): Promise<{ id: string; key: string; prefix: string }> {
  const live = await db.apiKey.count({
    where: { orgId: input.orgId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
  });
  if (live >= MAX_KEYS_PER_ORG)
    throw new ApiKeyError(`An organisation can have ${MAX_KEYS_PER_ORG} working keys. Revoke one first.`);
  if (input.expiresAt && input.expiresAt.getTime() <= now.getTime())
    throw new ApiKeyError('The expiry must be in the future.');
  const prefix = `kst_${randomBytes(4).toString('hex')}`;
  const secret = generateSecret();
  const row = await db.apiKey.create({
    data: {
      orgId: input.orgId,
      name: input.name,
      prefix,
      secretHash: hashSecret(secret),
      createdBy: input.userId,
      expiresAt: input.expiresAt,
    },
  });
  return { id: row.id, key: `${prefix}_${secret}`, prefix };
}

export async function listApiKeys(db: ApiKeyDb, orgId: string): Promise<ApiKeyView[]> {
  const rows = await db.apiKey.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' } });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
  }));
}

/** Stops a key working. False if there was no such live key in the organisation. */
export async function revokeApiKey(db: ApiKeyDb, orgId: string, id: string, now = new Date()): Promise<boolean> {
  const { count } = await db.apiKey.updateMany({ where: { id, orgId, revokedAt: null }, data: { revokedAt: now } });
  return count > 0;
}

export type AuthResult =
  | { ok: true; orgId: string; keyId: string }
  | { ok: false; status: 401; error: string };

const denied: AuthResult = { ok: false, status: 401, error: 'Missing, invalid or expired API key' };

/** Checks an Authorization header. Every failure looks the same, so nothing is learned from it. */
export async function authenticateApiKey(
  db: ApiKeyDb,
  header: string | null,
  now = new Date(),
): Promise<AuthResult> {
  const m = KEY.exec(header ?? '');
  if (!m) return denied;
  const [, prefix, secret] = m;
  const row = await db.apiKey.findFirst({ where: { prefix } });
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= now.getTime())) return denied;
  if (!secretMatches(secret!, row.secretHash)) return denied;
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_EVERY_MS)
    await db.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: now } });
  return { ok: true, orgId: row.orgId, keyId: row.id };
}

// ---- Rate limit ----------------------------------------------------------------------------------

/**
 * A simple per-key limit, counted in this server process. On a host that runs several copies each
 * counts on its own, so the real limit can be a few times higher; it is there to stop a runaway
 * script, not to be exact.
 */
export function makeRateLimiter(limit = REQUESTS_PER_MINUTE, windowMs = 60_000) {
  const seen = new Map<string, { start: number; count: number }>();
  return (key: string, now = Date.now()): { ok: boolean; retryAfterSeconds: number } => {
    if (seen.size > 5000)
      for (const [k, v] of seen) if (now - v.start >= windowMs) seen.delete(k);
    const cur = seen.get(key);
    if (!cur || now - cur.start >= windowMs) {
      seen.set(key, { start: now, count: 1 });
      return { ok: true, retryAfterSeconds: 0 };
    }
    cur.count++;
    return cur.count > limit
      ? { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((cur.start + windowMs - now) / 1000)) }
      : { ok: true, retryAfterSeconds: 0 };
  };
}
