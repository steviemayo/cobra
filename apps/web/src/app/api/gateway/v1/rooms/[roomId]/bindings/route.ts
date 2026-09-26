import { z } from 'zod';
import { withGateway } from '@/server/gateway-http';
import { bindings } from '@/server/gateway-service';
import { loadSigningKey } from '@/server/signing';

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export async function GET(req: Request, { params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return withGateway(req, async (gw, db) => {
    if (!uuid.safeParse(roomId).success) return { status: 400, body: { error: 'Bad room id' } };
    let signing = null;
    try {
      signing = loadSigningKey();
    } catch {
      // handled by the service: no key means a 503
    }
    return bindings(db, gw, roomId, signing);
  });
}
