import { db } from '@kestrel/db';
import { readJson, respond } from '@/server/gateway-http';
import { enroll } from '@/server/gateway-service';
import { trustedPublicKeys } from '@/server/signing';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return respond(await enroll(db, await readJson(req), trustedPublicKeys()));
}
