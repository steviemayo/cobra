import { after } from 'next/server';
import { db } from '@kestrel/db';
import { deliverAlerts, deliverDue } from '@/server/alerts';
import { cronAuthorised } from '@/server/cron-auth';
import { latencyJob } from '@/server/latency';
import { sweep } from '@/server/monitoring';
import { refreshSchedules } from '@/server/room-schedule';

export const dynamic = 'force-dynamic';

// Every minute or so, from anything that can call a URL: notices gateways that have gone quiet,
// which no heartbeat can report, expires commands nobody picked up, and sends alerts that channels
// with timing rules were holding back.
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return Response.json({ error: 'Unauthorised' }, { status: 401 });
  const jobs = await sweep(db);
  // Response times: rolls the pings up into hours and raises slow-network incidents.
  jobs.push(...(await latencyJob(db)));
  // Keeps the copy of each room's calendar fresh: it feeds fault alerts and maintenance checks.
  after(() =>
    refreshSchedules(db).then(
      () => undefined,
      (e: unknown) => console.error('[calendar] refresh failed', e),
    ),
  );
  if (jobs.length) after(() => deliverAlerts(db, jobs));
  // Alerts held back by a channel's hours or delay, and reminders for problems nobody has picked up.
  const due = await deliverDue(db).catch((e: unknown) => {
    console.error('[alerts] due delivery failed', e);
    return 0;
  });
  return Response.json({ alerts: jobs.length, due });
}
