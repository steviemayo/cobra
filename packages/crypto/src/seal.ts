import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Encrypts small secrets (calendar credentials) before they go into the database, so a database
// leak alone does not reveal them. AES-256-GCM with a random nonce; the key lives only in the
// server environment (KESTREL_SECRETS_KEY, 32 random bytes, base64).
const VERSION = 'v1';

function keyBytes(key: string): Buffer {
  const k = Buffer.from(key, 'base64');
  if (k.length !== 32) throw new Error('The secrets key must be 32 bytes, base64 encoded');
  return k;
}

/** A fresh key to put in KESTREL_SECRETS_KEY. */
export const generateSealKey = () => randomBytes(32).toString('base64');

export function seal(plaintext: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    data.toString('base64url'),
  ].join('.');
}

/** Throws if the value was tampered with, or sealed with a different key. */
export function open(sealed: string, key: string): string {
  const [v, iv, tag, data] = sealed.split('.');
  if (v !== VERSION || !iv || !tag || !data) throw new Error('Not a sealed value');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
