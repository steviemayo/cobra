import { describe, expect, it } from 'vitest';
import { buildMonthlyReport } from './monthly-report';
import {
  emailConfigured,
  monthKey,
  runReportSchedules,
  sendReportEmail,
  type DeliveryDb,
  type DeliveryDeps,
} from './report-delivery';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG2 = '11111111-1111-4111-8111-111111111112';
const ENV = { RESEND_API_KEY: 'key', ALERT_FROM_EMAIL: 'reports@example.com', NEXT_PUBLIC_APP_URL: 'https://app.example' };

function deps(env: Record<string, string | undefined> = ENV, status = 200) {
  const calls: { url: string; body: { to: string[]; subject: string; text: string } }[] = [];
  const d: DeliveryDeps = {
    env,
    fetch: (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response('{}', { status });
    }) as unknown as typeof fetch,
  };
  return { d, calls };
}

const schedule = (over: Record<string, unknown> = {}) => ({
  orgId: ORG,
  enabled: true,
  recipients: ['a@example.com', 'b@example.com'],
  timezone: 'UTC',
  lastSentMonth: null,
  ...over,
});

function world(schedules: Record<string, unknown>[]) {
  const reportSchedule = table(schedules);
  const db = {
    org: table([
      { id: ORG, name: 'Acme' },
      { id: ORG2, name: 'Other' },
    ]),
    room: table([]),
    roomDraft: table([]),
    gatewayEvent: table([]),
    incident: table([]),
    ticket: table([]),
    reportSchedule,
  } as unknown as DeliveryDb;
  return { db, reportSchedule };
}

describe('sending a report', () => {
  it('emails the report text to the recipients with a link to the portal', async () => {
    const { db } = world([]);
    const report = await buildMonthlyReport(db, ORG, { year: 2026, month: 9 }, 'UTC', new Date('2026-10-02T00:00:00Z'));
    const { d, calls } = deps();
    expect(await sendReportEmail(d, ['a@example.com'], ORG, report)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(calls[0]!.body.subject).toBe('[Kestrel] Acme: September 2026 report');
    expect(calls[0]!.body.text).toContain(`https://app.example/o/${ORG}/reports`);
  });

  it('does nothing when email is not set up or nobody is listed', async () => {
    const { db } = world([]);
    const report = await buildMonthlyReport(db, ORG, { year: 2026, month: 9 }, 'UTC', new Date('2026-10-02T00:00:00Z'));
    const none = deps({});
    expect(await sendReportEmail(none.d, ['a@example.com'], ORG, report)).toBe(false);
    expect(await sendReportEmail(deps().d, [], ORG, report)).toBe(false);
    expect(none.calls).toHaveLength(0);
    expect(emailConfigured({})).toBe(false);
    expect(emailConfigured(ENV)).toBe(true);
  });

  it('fails loudly when the email service refuses', async () => {
    const { db } = world([]);
    const report = await buildMonthlyReport(db, ORG, { year: 2026, month: 9 }, 'UTC', new Date('2026-10-02T00:00:00Z'));
    await expect(sendReportEmail(deps(ENV, 500).d, ['a@example.com'], ORG, report)).rejects.toThrow(/HTTP 500/);
  });
});

describe('the monthly schedule', () => {
  const FIRST = new Date('2026-10-02T03:00:00Z');

  it('sends last month once, and remembers it', async () => {
    const w = world([schedule()]);
    const { d, calls } = deps();
    expect(await runReportSchedules(w.db, FIRST, d)).toEqual([{ orgId: ORG, status: 'sent' }]);
    expect(calls[0]!.body.to).toEqual(['a@example.com', 'b@example.com']);
    expect(w.reportSchedule.rows[0]!.lastSentMonth).toBe('2026-09');
    // The next day's run finds it already sent.
    expect(await runReportSchedules(w.db, new Date('2026-10-03T03:00:00Z'), d)).toEqual([{ orgId: ORG, status: 'already_sent' }]);
    expect(calls).toHaveLength(1);
  });

  it('waits when switched on mid-month, and sends when the next month starts', async () => {
    const w = world([schedule()]);
    const { d, calls } = deps();
    expect(await runReportSchedules(w.db, new Date('2026-10-15T03:00:00Z'), d)).toEqual([{ orgId: ORG, status: 'too_early' }]);
    expect(calls).toHaveLength(0);
    expect(await runReportSchedules(w.db, new Date('2026-11-01T03:00:00Z'), d)).toEqual([{ orgId: ORG, status: 'sent' }]);
    expect(w.reportSchedule.rows[0]!.lastSentMonth).toBe('2026-10');
  });

  it('does not mark the month sent when email is not set up, so it goes out once it is', async () => {
    const w = world([schedule()]);
    expect(await runReportSchedules(w.db, FIRST, deps({}).d)).toEqual([{ orgId: ORG, status: 'no_email_setup' }]);
    expect(w.reportSchedule.rows[0]!.lastSentMonth).toBeNull();
    expect(await runReportSchedules(w.db, FIRST, deps().d)).toEqual([{ orgId: ORG, status: 'sent' }]);
  });

  it('reads the month and day in the schedule’s zone', async () => {
    // 20:00 UTC on 30 September is already 1 October in Sydney, so September is done.
    const w = world([schedule({ timezone: 'Australia/Sydney' })]);
    const { d } = deps();
    expect(await runReportSchedules(w.db, new Date('2026-09-30T20:00:00Z'), d)).toEqual([{ orgId: ORG, status: 'sent' }]);
    expect(w.reportSchedule.rows[0]!.lastSentMonth).toBe('2026-09');
  });

  it('skips switched-off schedules and empty lists, and one failure does not stop the rest', async () => {
    const w = world([
      schedule({ orgId: ORG2, enabled: false }),
      schedule({ orgId: 'empty', recipients: [] }),
      schedule(),
    ]);
    // The email service is down: the one organisation fails, and nothing else is attempted or marked.
    const out = await runReportSchedules(w.db, FIRST, deps(ENV, 503).d);
    expect(out).toEqual([{ orgId: ORG, status: 'failed', error: expect.stringContaining('503') }]);
    expect(w.reportSchedule.rows.find((r) => r.orgId === ORG)!.lastSentMonth).toBeNull();
  });

  it('formats the month key', () => {
    expect(monthKey({ year: 2026, month: 9 })).toBe('2026-09');
    expect(monthKey({ year: 2026, month: 12 })).toBe('2026-12');
  });
});
