import { createPublicKey } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '@kestrel/crypto';
import {
  bundleStatement,
  compareVersions,
  fileSha256,
  releasePublicKey,
  signBundle,
  verifyBundleSignature,
} from './release-signature';

const SHA = 'a'.repeat(64);
const keys = generateKeyPair();

describe('signing a bundle', () => {
  it('verifies for the version and digest that were signed, and nothing else', () => {
    const sig = signBundle(keys.privateKeyPem, '1.2.3', SHA);
    expect(verifyBundleSignature(keys.publicKeyPem, '1.2.3', SHA, sig)).toBe(true);
    expect(verifyBundleSignature(keys.publicKeyPem, '1.2.4', SHA, sig)).toBe(false);
    expect(verifyBundleSignature(keys.publicKeyPem, '1.2.3', 'b'.repeat(64), sig)).toBe(false);
    expect(verifyBundleSignature(generateKeyPair().publicKeyPem, '1.2.3', SHA, sig)).toBe(false);
  });

  it('treats a mangled or missing signature as not signed, never as an error', () => {
    for (const bad of ['', 'not base64 at all', 'AAAA', Buffer.from('short').toString('base64')])
      expect(verifyBundleSignature(keys.publicKeyPem, '1.2.3', SHA, bad), bad).toBe(false);
    expect(verifyBundleSignature('not a key', '1.2.3', SHA, 'AAAA')).toBe(false);
  });

  it('signs a fixed statement, so what CI signs and what gateways check cannot drift apart', () => {
    expect(bundleStatement('1.2.3', SHA.toUpperCase()).toString()).toBe(
      `kestrel-gateway-bundle|v1|1.2.3|${SHA}`,
    );
  });

  it('hashes a file the way the digest is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-sig-'));
    try {
      writeFileSync(join(dir, 'a.zip'), 'hello');
      expect(await fileSha256(join(dir, 'a.zip'))).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the key that ships in the gateway', () => {
  it('is an Ed25519 public key', () => {
    const key = createPublicKey(releasePublicKey());
    expect(key.type).toBe('public');
    expect(key.asymmetricKeyType).toBe('ed25519');
  });

  it('rejects a bundle signed by any other key', () => {
    const sig = signBundle(keys.privateKeyPem, '9.9.9', SHA);
    expect(verifyBundleSignature(releasePublicKey(), '9.9.9', SHA, sig)).toBe(false);
  });
});

describe('comparing versions', () => {
  it('compares each number, not the text', () => {
    expect(compareVersions('0.2.7', '0.2.8')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.2.7', '0.2.7')).toBe(0);
  });

  it('gives up on anything that is not dotted numbers', () => {
    expect(compareVersions('0.2.7-beta', '0.2.7')).toBeNull();
    expect(compareVersions('latest', '1.0.0')).toBeNull();
    expect(compareVersions('', '1.0.0')).toBeNull();
  });
});
