import { after } from 'next/server';
import { db } from '@kestrel/db';
import { queueAlerts } from '@/server/alert-batch';
import { deliverDue } from '@/server/alerts';
import { cronAuthorised } from '@/server/cron-auth';
import { syncDue } from '@/server/integrations/sync';
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
  // Vendor clouds (Zoom, ...): reads each integration that is due, so rooms with no gateway stay current.
  jobs.push(
    ...(await syncDue(db).catch((e: unknown) => {
      console.error('[integrations] sync failed', e);
      return [];
    })),
  );
  // Response times: rolls the pings up into hours and raises slow-network incidents.
  jobs.push(...(await latencyJob(db)));
  // Keeps the copy of each room's calendar fresh: it feeds fault alerts and maintenance checks.
  after(() =>
    refreshSchedules(db).then(
      () => undefined,
      (e: unknown) => console.error('[calendar] refresh failed', e),
    ),
  );
  if (jobs.length) after(() => queueAlerts(db, jobs));
  // Alerts held back by a channel's hours or delay, and reminders for problems nobody has picked up.
  const due = await deliverDue(db).catch((e: unknown) => {
    console.error('[alerts] due delivery failed', e);
    return 0;
  });
  return Response.json({ alerts: jobs.length, due });
}
