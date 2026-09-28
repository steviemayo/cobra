import type { PublicKey } from '@kestrel/model';

// The keys room releases and bindings must be signed with, built into the gateway. A gateway trusts
// only these (plus one an operator pins with KESTREL_PUBLIC_KEY), not keys the cloud sends it, so a
// compromised cloud or a machine in the path cannot hand a gateway a key of its own.
//
// To rotate the signing key: add the new key here and release a gateway, wait until the fleet has
// it, then switch the portal (KESTREL_SIGNING_KEY, with the old public key in
// KESTREL_EXTRA_PUBLIC_KEYS until every gateway has moved), and only then remove the old key here.
export const BUILT_IN_MANIFEST_KEYS: PublicKey[] = [
  {
    keyId: "2026-09-24",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAyc+93c7Q5XIoJ3Zl6KUP3deCYqD9RZDjkzmB2j2rxhk=\n-----END PUBLIC KEY-----\n",
  },
];
