import { writeFileSync } from 'node:fs';
import { fileSha256, signBundle } from '../src/release-signature';

// Run by CI on the release bundle: signs it with the release key and writes <zip>.sig.
//   GATEWAY_RELEASE_SIGNING_KEY=<base64 of the private key PEM> tsx scripts/sign-release.ts <zip> <version>
const [zip, version] = process.argv.slice(2);
const key = process.env.GATEWAY_RELEASE_SIGNING_KEY;
if (!zip || !version) {
  console.error('Usage: sign-release.ts <zip> <version>');
  process.exit(2);
}
if (!key) {
  console.error('GATEWAY_RELEASE_SIGNING_KEY is not set, so the bundle cannot be signed.');
  process.exit(1);
}
const sha256 = await fileSha256(zip);
const signature = signBundle(Buffer.from(key, 'base64').toString('utf8'), version, sha256);
writeFileSync(`${zip}.sig`, signature);
console.log(`Signed ${zip} ${version} (sha256 ${sha256})`);
