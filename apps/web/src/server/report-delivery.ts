import type { PrismaClient } from '@kestrel/db';
import { portalLink } from './alerts';
import { buildMonthlyReport, previousMonth, reportText, type MonthlyReport, type ReportDb, type ReportMonth } from './monthly-report';
import { emailConfigured, sendEmail } from './resend';

// Sending monthly reports: to one person on request, and to an organisation's list on the first days
// of each month. Email needs RESEND_API_KEY and ALERT_FROM_EMAIL on the server; without them nothing
// is sent (and a scheduled report is not marked as sent, so it goes out once email is set up).
export type DeliveryDb = ReportDb & Pick<PrismaClient, 'reportSchedule'>;

export interface DeliveryDeps {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
}
const realDeps = (): DeliveryDeps => ({ fetch, env: process.env });

export const MAX_REPORT_RECIPIENTS = 10;
/** A scheduled report goes out only in the first days of the month, so switching it on mid-month waits. */
export const SEND_WINDOW_DAYS = 7;

export const monthKey = (m: ReportMonth) => `${m.year}-${String(m.month).padStart(2, '0')}`;

export { emailConfigured };

/** Sends the report as plain text. False (without trying) when email is not set up. */
export async function sendReportEmail(
  d: DeliveryDeps,
  to: string[],
  orgId: string,
  report: MonthlyReport,
): Promise<boolean> {
  return sendEmail(
    d,
    to.slice(0, MAX_REPORT_RECIPIENTS),
    `[Kestrel] ${report.orgName}: ${report.label} report`,
    reportText(report, portalLink(orgId, '/reports', d.env) ?? undefined),
  );
}

/** The day of the month in a zone, 1 to 31. */
function localDay(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, day: 'numeric' }).formatToParts(now);
  return Number(parts.find((p) => p.type === 'day')!.value);
}

export interface ScheduleRun {
  orgId: string;
  status: 'sent' | 'already_sent' | 'too_early' | 'no_email_setup' | 'failed';
  error?: string;
}

/**
 * Sends last month's report to every organisation that has a schedule, once per month. Meant to run
 * daily. One organisation's failure does not stop the others.
 */
export async function runReportSchedules(
  db: DeliveryDb,
  now = new Date(),
  deps: DeliveryDeps = realDeps(),
): Promise<ScheduleRun[]> {
  const schedules = await db.reportSchedule.findMany({ where: { enabled: true } });
  const out: ScheduleRun[] = [];
  for (const s of schedules) {
    if (s.recipients.length === 0) continue;
    const month = previousMonth(now, s.timezone);
    if (s.lastSentMonth === monthKey(month)) {
      out.push({ orgId: s.orgId, status: 'already_sent' });
      continue;
    }
    if (localDay(now, s.timezone) > SEND_WINDOW_DAYS) {
      out.push({ orgId: s.orgId, status: 'too_early' });
      continue;
    }
    if (!emailConfigured(deps.env)) {
      out.push({ orgId: s.orgId, status: 'no_email_setup' });
      continue;
    }
    try {
      const report = await buildMonthlyReport(db, s.orgId, month, s.timezone, now);
      await sendReportEmail(deps, s.recipients, s.orgId, report);
      await db.reportSchedule.update({ where: { orgId: s.orgId }, data: { lastSentMonth: monthKey(month) } });
      out.push({ orgId: s.orgId, status: 'sent' });
    } catch (e) {
      out.push({ orgId: s.orgId, status: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
