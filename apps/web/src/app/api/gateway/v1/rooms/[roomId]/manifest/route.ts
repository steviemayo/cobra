import { z } from 'zod';
import { withGateway } from '@/server/gateway-http';
import { manifest } from '@/server/gateway-service';

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export async function GET(req: Request, { params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  const releaseId = new URL(req.url).searchParams.get('release');
  return withGateway(req, async (gw, db) =>
    uuid.safeParse(roomId).success && uuid.safeParse(releaseId).success
      ? manifest(db, gw, roomId, releaseId!)
      : { status: 400, body: { error: 'Bad room or release id' } },
  );
}
