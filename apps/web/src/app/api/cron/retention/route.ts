import { db } from '@kestrel/db';
import { cronAuthorised } from '@/server/cron-auth';
import { pruneOldData } from '@/server/retention';

export const dynamic = 'force-dynamic';

// Daily: deletes telemetry and history older than 90 days.
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return Response.json({ error: 'Unauthorised' }, { status: 401 });
  const res = await pruneOldData(db);
  return Response.json({ ...res, cutoff: res.cutoff.toISOString() });
}
