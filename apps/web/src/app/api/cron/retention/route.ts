import { db } from '@kestrel/db';
import { cronAuthorised } from '@/server/cron-auth';
import { pruneAudit } from '@/server/audit-retention';
import { pruneUnclaimed } from '@/server/gateway-announce';
import { runReportSchedules } from '@/server/report-delivery';
import { pruneOldData } from '@/server/retention';

export const dynamic = 'force-dynamic';

// Daily: deletes telemetry and history older than 90 days, and activity log rows past their
// retention (12 months unless staff extended it; billing and access changes are kept longer), and
// sends the monthly reports that are due.
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return Response.json({ error: 'Unauthorised' }, { status: 401 });
  const res = await pruneOldData(db);
  // Separate, so a problem with the activity log never stops the telemetry clean-up.
  const audit = await pruneAudit(db).catch((e: unknown) => ({
    error: e instanceof Error ? e.message : String(e),
  }));
  // Also daily, so it needs no cron of its own: monthly reports go out in the first days of a month.
  const reports = await runReportSchedules(db).catch((e: unknown) => ({
    error: e instanceof Error ? e.message : String(e),
  }));
  // Unclaimed gateways that have gone quiet, so an open endpoint cannot make the list grow for ever.
  const unclaimed = await pruneUnclaimed(db).catch((e: unknown) => ({
    error: e instanceof Error ? e.message : String(e),
  }));
  return Response.json({ ...res, cutoff: res.cutoff.toISOString(), audit, reports, unclaimed });
}
