import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';

// Gateway update bundles are signed by CI with a key that only CI holds (the GitHub Actions secret
// GATEWAY_RELEASE_SIGNING_KEY). Its public half ships inside the gateway
// (windows/release-public-key.pem). A gateway installs a bundle only if this signature checks out
// for the exact file it downloaded, so the portal, which tells gateways where to fetch a bundle,
// cannot make one install code it made up. What is signed is the version and the SHA-256 of the
// zip, so a signed old bundle cannot be passed off as a newer one either.

/** The exact bytes that are signed. */
export const bundleStatement = (version: string, sha256: string): Buffer =>
  Buffer.from(`kestrel-gateway-bundle|v1|${version}|${sha256.toLowerCase()}`);

export function signBundle(privateKeyPem: string, version: string, sha256: string): string {
  return edSign(null, bundleStatement(version, sha256), createPrivateKey(privateKeyPem)).toString(
    'base64',
  );
}

export function verifyBundleSignature(
  publicKeyPem: string,
  version: string,
  sha256: string,
  signatureBase64: string,
): boolean {
  try {
    return edVerify(
      null,
      bundleStatement(version, sha256),
      createPublicKey(publicKeyPem),
      Buffer.from(signatureBase64.trim(), 'base64'),
    );
  } catch {
    return false;
  }
}

/** The public key gateways trust for bundles, from the file that ships with them. */
export function releasePublicKey(): string {
  return readFileSync(new URL('../windows/release-public-key.pem', import.meta.url), 'utf8');
}

export function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => hash.update(c))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** "0.2.7" < "0.10.0": compares dotted numbers, or null when either is not one. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => (/^\d+(\.\d+){0,3}$/.test(v) ? v.split('.').map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
