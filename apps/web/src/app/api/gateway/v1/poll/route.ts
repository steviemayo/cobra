import { poll } from '@/server/control-service';
import { readJson, withGateway } from '@/server/gateway-http';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await readJson(req);
  return withGateway(req, (gw, db) => poll(db, gw, body));
}
