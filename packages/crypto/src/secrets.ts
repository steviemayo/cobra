import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

/** URL-safe random secret, e.g. an enrolment token or a gateway credential. */
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Fast hash for high-entropy secrets we generated ourselves (tokens, credentials). */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Constant-time comparison of a presented secret against its stored hash. */
export function secretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Panel PINs are short, so they get a salted, deliberately slow hash instead.
export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pin, salt, 32).toString('hex')}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pin, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
