import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { RoomManifest, type PublicKey, type SignedManifest } from '@kestrel/model';

/** JSON with keys sorted recursively and no whitespace, so equal data always hashes equally. */
export function canonicalJson(value: unknown): string {
  const plain: unknown = JSON.parse(JSON.stringify(value));
  const order = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(order);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, order(x)]),
      );
    return v;
  };
  return JSON.stringify(order(plain));
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hashManifest(manifest: unknown): string {
  return sha256Hex(canonicalJson(manifest));
}

export function generateKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export function publicKeyFromPrivate(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString();
}

/** Signs the manifest's hash. The manifest is normalised through the schema first. */
export function signManifest(
  input: unknown,
  key: { privateKeyPem: string; keyId: string },
): SignedManifest {
  const manifest = RoomManifest.parse(input);
  const hash = hashManifest(manifest);
  const signature = sign(null, Buffer.from(hash), createPrivateKey(key.privateKeyPem)).toString('base64');
  return { manifest, hash, signature, keyId: key.keyId };
}

export type VerifyResult =
  | { ok: true; signed: SignedManifest }
  | { ok: false; reason: 'malformed' | 'hash_mismatch' | 'unknown_key' | 'bad_signature' | 'invalid_manifest' };

/**
 * Checks a manifest exactly as received: the hash must match its canonical JSON, the signature must
 * be valid for one of the trusted keys, and only then is it parsed. A gateway refuses anything else.
 */
export function verifyManifest(raw: unknown, trusted: PublicKey[]): VerifyResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'malformed' };
  const r = raw as Record<string, unknown>;
  if (
    typeof r.hash !== 'string' ||
    typeof r.signature !== 'string' ||
    typeof r.keyId !== 'string' ||
    typeof r.manifest !== 'object' ||
    r.manifest === null
  )
    return { ok: false, reason: 'malformed' };

  if (hashManifest(r.manifest) !== r.hash) return { ok: false, reason: 'hash_mismatch' };

  const key = trusted.find((k) => k.keyId === r.keyId);
  if (!key) return { ok: false, reason: 'unknown_key' };
  let valid: boolean;
  try {
    valid = verify(
      null,
      Buffer.from(r.hash),
      createPublicKey(key.publicKeyPem),
      Buffer.from(r.signature, 'base64'),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };

  const parsed = RoomManifest.safeParse(r.manifest);
  if (!parsed.success) return { ok: false, reason: 'invalid_manifest' };
  return { ok: true, signed: { manifest: parsed.data, hash: r.hash, signature: r.signature, keyId: r.keyId } };
}
