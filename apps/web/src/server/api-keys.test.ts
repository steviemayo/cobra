import { describe, expect, it } from 'vitest';
import {
  ApiKeyError,
  LAST_USED_EVERY_MS,
  MAX_KEYS_PER_ORG,
  authenticateApiKey,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyDb,
} from './api-keys';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '11111111-1111-4111-8111-111111111112';
const NOW = new Date('2026-09-27T10:00:00Z');

function world() {
  const apiKey = table([]);
  return { db: { apiKey } as unknown as ApiKeyDb, apiKey };
}
const make = (db: ApiKeyDb, over: Partial<Parameters<typeof createApiKey>[1]> = {}) =>
  createApiKey(db, { orgId: ORG, name: 'BMS', userId: 'u1', expiresAt: null, ...over }, NOW);
const bearer = (key: string) => `Bearer ${key}`;

describe('making a key', () => {
  it('gives a key that looks right, and stores only a hash of its secret', async () => {
    const w = world();
    const made = await make(w.db);
    expect(made.key).toMatch(/^kst_[0-9a-f]{8}_[A-Za-z0-9_-]{40,}$/);
    expect(made.key.startsWith(made.prefix)).toBe(true);
    const row = w.apiKey.rows[0]!;
    // The secret is everything after "kst_<id>_"; it can itself contain underscores, so splitting on
    // them would sometimes leave a one-letter fragment that appears in the row by chance.
    const secret = made.key.slice(made.prefix.length + 1);
    expect(secret.length).toBeGreaterThanOrEqual(40);
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row).toMatchObject({ orgId: ORG, name: 'BMS', prefix: made.prefix, createdBy: 'u1' });
  });

  it('makes a different key each time', async () => {
    const w = world();
    expect((await make(w.db)).key).not.toBe((await make(w.db)).key);
  });

  it('limits how many keys an organisation can have working, ignoring revoked and expired ones', async () => {
    const w = world();
    for (let i = 0; i < MAX_KEYS_PER_ORG; i++) await make(w.db);
    await expect(make(w.db)).rejects.toThrow(ApiKeyError);
    // Another organisation is not affected.
    await expect(make(w.db, { orgId: OTHER })).resolves.toBeDefined();
    w.apiKey.rows[0]!.revokedAt = NOW;
    await expect(make(w.db)).resolves.toBeDefined();
    await expect(make(w.db)).rejects.toThrow(ApiKeyError);
    w.apiKey.rows[1]!.expiresAt = new Date(NOW.getTime() - 1);
    await expect(make(w.db)).resolves.toBeDefined();
  });

  it('refuses an expiry in the past', async () => {
    await expect(make(world().db, { expiresAt: new Date(NOW.getTime() - 1000) })).rejects.toThrow(
      /future/,
    );
  });
});

describe('using a key', () => {
  it('lets a good key in, as its organisation', async () => {
    const w = world();
    const { key } = await make(w.db);
    expect(await authenticateApiKey(w.db, bearer(key), NOW)).toEqual({
      ok: true,
      orgId: ORG,
      keyId: w.apiKey.rows[0]!.id,
    });
  });

  it('turns away every kind of bad key the same way', async () => {
    const w = world();
    const { key, prefix } = await make(w.db);
    const secret = key.slice(prefix.length + 1);
    const bad = [
      null,
      '',
      key, // no "Bearer"
      'Bearer nonsense',
      bearer(`${prefix}_${secret}x`), // wrong secret
      bearer(`${prefix}_${'a'.repeat(secret.length)}`),
      bearer(`kst_00000000_${secret}`), // unknown key
    ];
    for (const h of bad)
      expect(await authenticateApiKey(w.db, h, NOW)).toEqual({
        ok: false,
        status: 401,
        error: 'Missing, invalid or expired API key',
      });
  });

  it('refuses a revoked key and one past its expiry', async () => {
    const w = world();
    const a = await make(w.db);
    const b = await make(w.db, { expiresAt: new Date(NOW.getTime() + 1000) });
    expect((await authenticateApiKey(w.db, bearer(b.key), NOW)).ok).toBe(true);
    expect((await authenticateApiKey(w.db, bearer(b.key), new Date(NOW.getTime() + 1000))).ok).toBe(
      false,
    );
    expect(await revokeApiKey(w.db, ORG, a.id, NOW)).toBe(true);
    expect((await authenticateApiKey(w.db, bearer(a.key), NOW)).ok).toBe(false);
  });

  it('notes when a key was last used, but not on every request', async () => {
    const w = world();
    const { key } = await make(w.db);
    await authenticateApiKey(w.db, bearer(key), NOW);
    expect(w.apiKey.rows[0]!.lastUsedAt).toEqual(NOW);
    await authenticateApiKey(w.db, bearer(key), new Date(NOW.getTime() + 1000));
    expect(w.apiKey.rows[0]!.lastUsedAt).toEqual(NOW);
    const later = new Date(NOW.getTime() + LAST_USED_EVERY_MS);
    await authenticateApiKey(w.db, bearer(key), later);
    expect(w.apiKey.rows[0]!.lastUsedAt).toEqual(later);
  });
});

describe('managing keys', () => {
  it('lists an organisation’s keys without any secret, and only its own', async () => {
    const w = world();
    await make(w.db);
    await make(w.db, { orgId: OTHER });
    const list = await listApiKeys(w.db, ORG);
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]!).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'id',
      'lastUsedAt',
      'name',
      'prefix',
      'revokedAt',
    ]);
  });

  it('revokes only a live key of the organisation, once', async () => {
    const w = world();
    const { id } = await make(w.db);
    expect(await revokeApiKey(w.db, OTHER, id, NOW)).toBe(false);
    expect(await revokeApiKey(w.db, ORG, id, NOW)).toBe(true);
    expect(await revokeApiKey(w.db, ORG, id, NOW)).toBe(false);
  });
});
