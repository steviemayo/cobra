import { withApiKey } from '@/server/api-http';
import { listRooms } from '@/server/public-api';

export const dynamic = 'force-dynamic';

// GET /api/v1/rooms: every room of the organisation the key belongs to.
export async function GET(req: Request) {
  return withApiKey(req, async ({ orgId, db }) => ({ body: { data: await listRooms(db, orgId) } }));
}
