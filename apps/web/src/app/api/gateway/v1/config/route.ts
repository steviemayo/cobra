import { withGateway } from '@/server/gateway-http';
import { config } from '@/server/gateway-service';
import { trustedPublicKeys } from '@/server/signing';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return withGateway(req, (gw, db) => config(db, gw, trustedPublicKeys()));
}
