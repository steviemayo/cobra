import { z } from 'zod';
import { withApiKey } from '@/server/api-http';
import { MAX_PAGE, listIncidents } from '@/server/public-api';

export const dynamic = 'force-dynamic';

const Query = z.object({
  status: z.enum(['open', 'resolved']).optional(),
  room: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
});

// GET /api/v1/incidents?status=open&room={roomId}&limit=50: newest first.
export async function GET(req: Request) {
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  return withApiKey(req, async ({ orgId, db }) => {
    if (!parsed.success) return { status: 400, body: { error: 'Bad query: status is open or resolved, room is a room id, limit is 1 to 200' } };
    const { status, room, limit } = parsed.data;
    return { body: { data: await listIncidents(db, orgId, { status, roomId: room, limit }) } };
  });
}
