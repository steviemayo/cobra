import { withGateway } from '@/server/gateway-http';
import { deviceSet } from '@/server/gateway-service';
import { loadSigningKey } from '@/server/signing';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return withGateway(req, async (gw, db) => {
    let signing = null;
    try {
      signing = loadSigningKey();
    } catch {
      // handled by the service: no key means a 503
    }
    return deviceSet(db, gw, signing);
  });
}
