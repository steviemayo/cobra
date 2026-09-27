import { z } from 'zod';
import { withApiKey } from '@/server/api-http';
import { getRoom } from '@/server/public-api';

export const dynamic = 'force-dynamic';

// GET /api/v1/rooms/{roomId}: one room, with its devices and how many problems are open.
export async function GET(req: Request, { params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return withApiKey(req, async ({ orgId, db }) => {
    if (!z.string().uuid().safeParse(roomId).success) return { status: 404, body: { error: 'Room not found' } };
    const room = await getRoom(db, orgId, roomId);
    return room ? { body: { data: room } } : { status: 404, body: { error: 'Room not found' } };
  });
}
