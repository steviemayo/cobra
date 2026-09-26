import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { BindingsPayload, SignedBindings, type PublicKey } from '@kestrel/model';
import { ANY_KEY_ID, hashManifest } from './manifest';

/** Signs a room's bindings the way a manifest is signed: Ed25519 over the hash of the canonical JSON. */
export function signBindings(
  input: unknown,
  key: { privateKeyPem: string; keyId: string },
): SignedBindings {
  const payload = BindingsPayload.parse(input);
  const hash = hashManifest(payload);
  const signature = sign(null, Buffer.from(hash), createPrivateKey(key.privateKeyPem)).toString('base64');
  return { payload, hash, signature, keyId: key.keyId };
}

export type VerifyBindingsResult =
  | { ok: true; signed: SignedBindings }
  | { ok: false; reason: 'malformed' | 'hash_mismatch' | 'unknown_key' | 'bad_signature' | 'invalid_bindings' };

/** Checks bindings exactly as received, then parses them. A gateway refuses anything else. */
export function verifyBindings(raw: unknown, trusted: PublicKey[]): VerifyBindingsResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'malformed' };
  const r = raw as Record<string, unknown>;
  if (
    typeof r.hash !== 'string' ||
    typeof r.signature !== 'string' ||
    typeof r.keyId !== 'string' ||
    typeof r.payload !== 'object' ||
    r.payload === null
  )
    return { ok: false, reason: 'malformed' };
  if (hashManifest(r.payload) !== r.hash) return { ok: false, reason: 'hash_mismatch' };
  const candidates = trusted.filter((k) => k.keyId === r.keyId || k.keyId === ANY_KEY_ID);
  if (candidates.length === 0) return { ok: false, reason: 'unknown_key' };
  const valid = candidates.some((key) => {
    try {
      return verify(
        null,
        Buffer.from(r.hash as string),
        createPublicKey(key.publicKeyPem),
        Buffer.from(r.signature as string, 'base64'),
      );
    } catch {
      return false;
    }
  });
  if (!valid) return { ok: false, reason: 'bad_signature' };
  const parsed = SignedBindings.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid_bindings' };
  return { ok: true, signed: parsed.data };
}
