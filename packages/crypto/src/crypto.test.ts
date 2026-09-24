import { createPrivateKey, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, type PublicKey } from '@kestrel/model';
import {
  canonicalJson,
  generateKeyPair,
  generateSealKey,
  generateSecret,
  hashManifest,
  hashPin,
  hashSecret,
  parseAccess,
  signAccess,
  verifyAccess,
  publicKeyFromPrivate,
  open,
  seal,
  secretMatches,
  signManifest,
  verifyManifest,
  verifyPin,
} from './index';

const manifestInput = () => ({
  manifestVersion: 1,
  orgId: '11111111-1111-4111-8111-111111111111',
  roomId: '33333333-3333-4333-8333-333333333331',
  roomName: 'Boardroom',
  releaseId: '44444444-4444-4444-8444-444444444441',
  releaseNumber: 1,
  createdAt: '2026-09-24T10:00:00.000Z',
  model: structuredClone(STARTER_TEMPLATES[0]!.model),
});

const keys = generateKeyPair();
const signing = { privateKeyPem: keys.privateKeyPem, keyId: 'k1' };
const trusted: PublicKey[] = [{ keyId: 'k1', publicKeyPem: keys.publicKeyPem }];
/** What actually crosses the wire. */
const wire = (v: unknown) => JSON.parse(JSON.stringify(v)) as Record<string, unknown>;

describe('canonicalJson', () => {
  it('ignores key order and whitespace, so equal data hashes equally', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: [1, { y: 2, z: 1 }] }, b: 1 }),
    );
    expect(hashManifest({ a: 1, b: 2 })).toBe(hashManifest({ b: 2, a: 1 }));
  });

  it('drops undefined like JSON does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('keeps array order', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('signing and verification', () => {
  it('a signed manifest verifies, after a JSON round trip', () => {
    const signed = signManifest(manifestInput(), signing);
    expect(signed.hash).toMatch(/^[0-9a-f]{64}$/);
    const result = verifyManifest(wire(signed), trusted);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.signed.manifest.roomName).toBe('Boardroom');
  });

  it('applies schema defaults when signing, and they survive the round trip', () => {
    const signed = signManifest(manifestInput(), signing);
    expect(signed.manifest.panel.access.mode).toBe('open');
    expect(verifyManifest(wire(signed), trusted).ok).toBe(true);
  });

  it('rejects a manifest changed after signing', () => {
    const tampered = wire(signManifest(manifestInput(), signing));
    (tampered.manifest as { roomName: string }).roomName = 'Somewhere else';
    expect(verifyManifest(tampered, trusted)).toEqual({ ok: false, reason: 'hash_mismatch' });
  });

  it('rejects a swapped hash and signature from a different key', () => {
    const other = generateKeyPair();
    const forged = wire(
      signManifest(manifestInput(), { privateKeyPem: other.privateKeyPem, keyId: 'k1' }),
    );
    expect(verifyManifest(forged, trusted)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an unknown key id', () => {
    const signed = wire(signManifest(manifestInput(), { ...signing, keyId: 'other' }));
    expect(verifyManifest(signed, trusted)).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('rejects a signature that is not valid base64 data', () => {
    const signed = wire(signManifest(manifestInput(), signing));
    signed.signature = 'not-a-signature';
    expect(verifyManifest(signed, trusted)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of [null, 'x', 42, {}, { manifest: {}, hash: 1 }])
      expect(verifyManifest(bad, trusted)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a correctly signed manifest that does not match the schema', () => {
    // Sign something invalid by hand, as a buggy or malicious signer might.
    const bad = { manifestVersion: 1, roomName: 5 };
    const hash = hashManifest(bad);
    const signature = sign(null, Buffer.from(hash), createPrivateKey(keys.privateKeyPem)).toString(
      'base64',
    );
    expect(verifyManifest({ manifest: bad, hash, signature, keyId: 'k1' }, trusted)).toEqual({
      ok: false,
      reason: 'invalid_manifest',
    });
  });

  it('refuses to sign an invalid manifest', () => {
    expect(() => signManifest({ ...manifestInput(), roomId: 'nope' }, signing)).toThrow();
  });

  it('derives the public key from the private key', () => {
    expect(publicKeyFromPrivate(keys.privateKeyPem)).toBe(keys.publicKeyPem);
  });

  it('a wildcard (pinned) key verifies any signer label, but only for the right key pair', () => {
    const pinned: PublicKey[] = [{ keyId: '*', publicKeyPem: keys.publicKeyPem }];
    const signed = wire(signManifest(manifestInput(), { ...signing, keyId: 'whatever-label' }));
    expect(verifyManifest(signed, pinned).ok).toBe(true);
    const other = generateKeyPair();
    const forged = wire(
      signManifest(manifestInput(), {
        privateKeyPem: other.privateKeyPem,
        keyId: 'whatever-label',
      }),
    );
    expect(verifyManifest(forged, pinned)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('accepts either of several trusted keys (rotation)', () => {
    const next = generateKeyPair();
    const both: PublicKey[] = [...trusted, { keyId: 'k2', publicKeyPem: next.publicKeyPem }];
    const signed = wire(
      signManifest(manifestInput(), { privateKeyPem: next.privateKeyPem, keyId: 'k2' }),
    );
    expect(verifyManifest(signed, both).ok).toBe(true);
  });
});

describe('secrets', () => {
  it('generates unique url-safe secrets', () => {
    const a = generateSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(generateSecret());
  });

  it('matches a secret against its stored hash only', () => {
    const s = generateSecret();
    const stored = hashSecret(s);
    expect(secretMatches(s, stored)).toBe(true);
    expect(secretMatches(s + 'x', stored)).toBe(false);
    expect(secretMatches(s, 'not-hex')).toBe(false);
  });

  it('hashes PINs with a salt and verifies them', () => {
    const stored = hashPin('4821');
    expect(stored).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(stored).not.toBe(hashPin('4821'));
    expect(verifyPin('4821', stored)).toBe(true);
    expect(verifyPin('4822', stored)).toBe(false);
    expect(verifyPin('4821', 'garbage')).toBe(false);
  });
});

describe('sealed secrets', () => {
  const key = generateSealKey();

  it('round-trips, with a different ciphertext each time', () => {
    const a = seal('{"clientSecret":"s3cret"}', key);
    const b = seal('{"clientSecret":"s3cret"}', key);
    expect(a).not.toBe(b);
    expect(a).not.toContain('s3cret');
    expect(open(a, key)).toBe('{"clientSecret":"s3cret"}');
  });

  it('refuses a different key, a changed value and junk', () => {
    const sealed = seal('hello', key);
    expect(() => open(sealed, generateSealKey())).toThrow();
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => open(parts.join('.'), key)).toThrow();
    expect(() => open('nonsense', key)).toThrow('Not a sealed value');
  });

  it('insists on a real 32-byte key', () => {
    expect(() => seal('x', 'c2hvcnQ=')).toThrow('32 bytes');
  });
});

describe('phone access tokens', () => {
  const secret = generateSecret();
  const room = '33333333-3333-4333-8333-333333333331';
  const other = '33333333-3333-4333-8333-333333333332';
  const now = 1_800_000_000;

  it('verify for the room, kind and secret they were made for, until they expire', () => {
    const t = signAccess(secret, 'join', room, now + 600);
    expect(verifyAccess(secret, 'join', t, now)).toEqual({ roomId: room, exp: now + 600 });
    expect(verifyAccess(secret, 'join', t, now + 599)).not.toBeNull();
    expect(verifyAccess(secret, 'join', t, now + 600)).toBeNull();
  });

  it('refuse another kind, another secret, or a token edited to name another room or time', () => {
    const t = signAccess(secret, 'join', room, now + 600);
    expect(verifyAccess(secret, 'session', t, now)).toBeNull();
    expect(verifyAccess(generateSecret(), 'join', t, now)).toBeNull();
    expect(verifyAccess(secret, 'join', t.replace(room, other), now)).toBeNull();
    expect(verifyAccess(secret, 'join', t.replace(String(now + 600), String(now + 6000)), now)).toBeNull();
  });

  it('read a token’s room without trusting it, and reject junk', () => {
    expect(parseAccess(signAccess(secret, 'join', room, now))).toEqual({ roomId: room, exp: now });
    for (const bad of ['', 'nope', `${room}.abc.xyz`, `${room}.${now}.short`, `${room}.${now}`])
      expect(parseAccess(bad), bad).toBeNull();
    expect(verifyAccess(secret, 'join', 'junk', now)).toBeNull();
  });
});
