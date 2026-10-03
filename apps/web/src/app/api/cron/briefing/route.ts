import { db } from '@kestrel/db';
import { cronAuthorised } from '@/server/cron-auth';
import { runBriefings } from '@/server/briefing-delivery';

export const dynamic = 'force-dynamic';

// Daily, early morning in Sydney: sends the briefing to everyone who signed up for it.
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return Response.json({ error: 'Unauthorised' }, { status: 401 });
  return Response.json(await runBriefings(db));
}
