import { publicKeyFromPrivate } from '@kestrel/crypto';
import type { PublicKey } from '@kestrel/model';

export class SigningNotConfigured extends Error {
  constructor() {
    super(
      'Release signing is not configured. Set KESTREL_SIGNING_KEY and KESTREL_SIGNING_KEY_ID ' +
        '(generate them with `pnpm --filter @kestrel/crypto keygen`).',
    );
  }
}

export interface SigningKey {
  keyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

type Env = Record<string, string | undefined>;

/** The active signing key, from env. The private key never leaves the server. */
export function loadSigningKey(env: Env = process.env): SigningKey {
  const encoded = env.KESTREL_SIGNING_KEY;
  const keyId = env.KESTREL_SIGNING_KEY_ID;
  if (!encoded || !keyId) throw new SigningNotConfigured();
  const privateKeyPem = Buffer.from(encoded, 'base64').toString('utf8');
  return { keyId, privateKeyPem, publicKeyPem: publicKeyFromPrivate(privateKeyPem) };
}

/**
 * Public keys gateways should trust: the active key plus any older ones still in service
 * (KESTREL_EXTRA_PUBLIC_KEYS, a JSON array of { keyId, publicKeyPem }) during a key rotation.
 */
export function trustedPublicKeys(env: Env = process.env): PublicKey[] {
  const keys: PublicKey[] = [];
  try {
    const active = loadSigningKey(env);
    keys.push({ keyId: active.keyId, publicKeyPem: active.publicKeyPem });
  } catch {
    // No active key yet: gateways just get whatever extras are configured.
  }
  if (env.KESTREL_EXTRA_PUBLIC_KEYS) {
    try {
      const extra = JSON.parse(env.KESTREL_EXTRA_PUBLIC_KEYS) as PublicKey[];
      for (const k of extra) if (k.keyId && k.publicKeyPem) keys.push(k);
    } catch {
      // Ignore malformed extras rather than break enrolment.
    }
  }
  return keys;
}
