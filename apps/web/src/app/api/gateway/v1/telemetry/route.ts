import { readJson, withGateway } from '@/server/gateway-http';
import { telemetry } from '@/server/gateway-service';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await readJson(req);
  return withGateway(req, (gw, db) => telemetry(db, gw, body));
}
