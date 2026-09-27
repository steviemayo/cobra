import { after } from 'next/server';
import { db } from '@kestrel/db';
import { deliverAlerts, deliverDue } from '@/server/alerts';
import { cronAuthorised } from '@/server/cron-auth';
import { sweep } from '@/server/monitoring';

export const dynamic = 'force-dynamic';

// Every minute or so, from anything that can call a URL: notices gateways that have gone quiet,
// which no heartbeat can report, expires commands nobody picked up, and sends alerts that channels
// with timing rules were holding back.
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return Response.json({ error: 'Unauthorised' }, { status: 401 });
  const jobs = await sweep(db);
  if (jobs.length) after(() => deliverAlerts(db, jobs));
  // Alerts held back by a channel's hours or delay, and reminders for problems nobody has picked up.
  const due = await deliverDue(db).catch((e: unknown) => {
    console.error('[alerts] due delivery failed', e);
    return 0;
  });
  return Response.json({ alerts: jobs.length, due });
}
