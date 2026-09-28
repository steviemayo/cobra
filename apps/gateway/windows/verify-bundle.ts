import { readFileSync } from 'node:fs';
import { compareVersions, fileSha256, releasePublicKey, verifyBundleSignature } from '../src/release-signature';

// Run by update.ps1 (as the system) with the INSTALLED gateway's own node and files, before it
// swaps in a staged bundle: exits 0 only if the zip is exactly the one Kestrel signed for this
// version, and the version is newer than the one installed.
//   node --import tsx windows/verify-bundle.ts <zip> <signature file> <version> <installed version>
const [zip, sigFile, version, installed] = process.argv.slice(2);
const fail = (why: string): never => {
  console.error(why);
  process.exit(1);
};
if (!zip || !sigFile || !version) fail('Usage: verify-bundle.ts <zip> <signature file> <version> [installed version]');
if (installed) {
  const order = compareVersions(version!, installed);
  if (order === null) fail(`Cannot compare version ${version} with ${installed}`);
  if (order! <= 0) fail(`Version ${version} is not newer than the installed ${installed}`);
}
const ok = verifyBundleSignature(
  releasePublicKey(),
  version!,
  await fileSha256(zip!),
  readFileSync(sigFile!, 'utf8'),
);
if (!ok) fail('The bundle is not signed by Kestrel for this version');
console.log('The bundle is signed by Kestrel');
