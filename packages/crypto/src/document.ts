import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { PublicKey } from '@kestrel/model';
import { ANY_KEY_ID, hashManifest } from './manifest';

// A signed document: any JSON Kestrel issues for keeping (an asset register, a maintenance report).
// Signed exactly like a manifest (Ed25519 over the hash of the canonical JSON), and tagged with what
// it is for so a signature made for one purpose cannot be passed off as another.
export interface SignedDocument<T = unknown> {
  /** What this is: "register_issue", "pm_report". Part of what is signed. */
  purpose: string;
  payload: T;
  hash: string;
  signature: string;
  keyId: string;
}

const envelope = (purpose: string, payload: unknown) => ({ purpose, payload });

export function signDocument<T>(
  purpose: string,
  payload: T,
  key: { privateKeyPem: string; keyId: string },
): SignedDocument<T> {
  const hash = hashManifest(envelope(purpose, payload));
  const signature = sign(null, Buffer.from(hash), createPrivateKey(key.privateKeyPem)).toString(
    'base64',
  );
  return { purpose, payload, hash, signature, keyId: key.keyId };
}

export type VerifyDocumentResult =
  | { ok: true; document: SignedDocument }
  | {
      ok: false;
      reason: 'malformed' | 'wrong_purpose' | 'hash_mismatch' | 'unknown_key' | 'bad_signature';
    };

/** Checks a document exactly as received: its purpose, its hash and its signature. */
export function verifyDocument(
  raw: unknown,
  purpose: string,
  trusted: PublicKey[],
): VerifyDocumentResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'malformed' };
  const r = raw as Record<string, unknown>;
  if (
    typeof r.purpose !== 'string' ||
    typeof r.hash !== 'string' ||
    typeof r.signature !== 'string' ||
    typeof r.keyId !== 'string' ||
    r.payload === undefined
  )
    return { ok: false, reason: 'malformed' };
  if (r.purpose !== purpose) return { ok: false, reason: 'wrong_purpose' };
  if (hashManifest(envelope(r.purpose, r.payload)) !== r.hash)
    return { ok: false, reason: 'hash_mismatch' };
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
  return { ok: true, document: raw as SignedDocument };
}
