import { after } from 'next/server';
import { db } from '@kestrel/db';
import { deliverAlerts } from '@/server/alerts';
import { cronAuthorised } from '@/server/cron-auth';
import { sweep } from '@/server/monitoring';

export const dynamic = 'force-dynamic';

// Every minute or so, from anything that can call a URL: notices gateways that have gone quiet,
// which no heartbeat can report, and expires commands nobody picked up.
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return Response.json({ error: 'Unauthorised' }, { status: 401 });
  const jobs = await sweep(db);
  if (jobs.length) after(() => deliverAlerts(db, jobs));
  return Response.json({ alerts: jobs.length });
}
