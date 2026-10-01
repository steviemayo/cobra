import { db } from '@kestrel/db';
import { cronAuthorised } from '@/server/cron-auth';
import { pruneAudit } from '@/server/audit-retention';
import { pruneUnclaimed } from '@/server/gateway-announce';
import { runReportSchedules } from '@/server/report-delivery';
import { purgeDueOrgs } from '@/server/org-deletion';
import { pruneOldData } from '@/server/retention';
import { pruneUsage, rollupUsage } from '@/server/usage-service';
import { getEntitlements } from '@/server/billing';
import { snapshotAll } from '@/server/config-service';
import { expireGrants } from '@/server/msp-portfolio';
import { pmSweep } from '@/server/pm-service';
import { runScheduledIssues } from '@/server/register-issues';
import { loadSigningKey } from '@/server/signing';

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
  // Usage: store the last two days as daily figures first, then drop readings past 90 days.
  const usage = await rollupUsage(db).catch((e: unknown) => ({
    error: e instanceof Error ? e.message : String(e),
  }));
  const usagePruned = await pruneUsage(db).catch((e: unknown) => ({
    error: e instanceof Error ? e.message : String(e),
  }));
  // A scheduled snapshot of every monitored device, so there is something to compare with.
  const snapshots = await snapshotAll(
    db,
    new Date(),
    async (orgId) => (await getEntitlements(db, orgId)).configuration,
  ).catch((e: unknown) => ({
    error: e instanceof Error ? e.message : String(e),
  }));
  // Overdue maintenance becomes an info notice, and any register issue on a schedule is taken.
  const pm = await pmSweep(db)
    .then((j) => ({ notices: j.length }))
    .catch((e: unknown) => ({
      error: e instanceof Error ? e.message : String(e),
    }));
  const register = await (async () => {
    try {
      return { issued: await runScheduledIssues(db, loadSigningKey()) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  })();
  // Connections to service providers that were given an end date.
  const grants = await expireGrants(db as never).catch((e: unknown) => ({
    error: e instanceof Error ? e.message : String(e),
  }));
  // Organisations whose 30 days are up are deleted for good (each one tried again next time if it fails).
  const orgsPurged = await purgeDueOrgs(db).catch((e: unknown) => ({
    error: e instanceof Error ? e.message : String(e),
  }));
  return Response.json({
    ...res,
    orgsPurged,
    grants,
    snapshots,
    pm,
    register,
    cutoff: res.cutoff.toISOString(),
    audit,
    reports,
    unclaimed,
    usage,
    usagePruned,
  });
}
