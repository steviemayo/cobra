import { generateKeyPair } from './manifest';

// Prints a new signing key for the cloud (KESTREL_SIGNING_KEY) and the matching public key.
const { privateKeyPem, publicKeyPem } = generateKeyPair();
const b64 = (s: string) => Buffer.from(s).toString('base64');
console.log('Add to the web app environment (Vercel and .env). Keep the private key secret.\n');
console.log(`KESTREL_SIGNING_KEY_ID=${new Date().toISOString().slice(0, 10)}`);
console.log(`KESTREL_SIGNING_KEY=${b64(privateKeyPem)}\n`);
console.log('Public key (safe to share; gateways receive it at enrolment):\n');
console.log(publicKeyPem);
