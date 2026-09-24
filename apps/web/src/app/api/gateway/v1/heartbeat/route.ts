import { readJson, withGateway } from '@/server/gateway-http';
import { heartbeat } from '@/server/gateway-service';
import { trustedPublicKeys } from '@/server/signing';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await readJson(req);
  return withGateway(req, (gw, db) => heartbeat(db, gw, body, trustedPublicKeys()));
}
