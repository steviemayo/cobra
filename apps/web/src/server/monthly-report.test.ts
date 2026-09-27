import { describe, expect, it } from 'vitest';
import { buildMonthlyReport, previousMonth, reportText, type ReportDb } from './monthly-report';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222221';
const R1 = '33333333-3333-4333-8333-333333333331';
const R2 = '33333333-3333-4333-8333-333333333332';
const NOW = new Date('2026-10-02T00:00:00Z');

// September 2026 in UTC: 30 days = 43,200 minutes.
const SEPT = { year: 2026, month: 9 };

const at = (s: string) => new Date(s);
const status = (roomId: string, when: string, s: string) => ({ orgId: ORG, roomId, type: 'room.status', at: at(when), data: { status: s } });

function world(over: { incidents?: Record<string, unknown>[]; tickets?: Record<string, unknown>[]; events?: Record<string, unknown>[] } = {}) {
  return {
    org: table([{ id: ORG, name: 'Acme' }]),
    room: table([
      { id: R1, orgId: ORG, siteId: SITE, name: 'Boardroom' },
      { id: R2, orgId: ORG, siteId: SITE, name: 'Annex' },
    ]),
    roomDraft: table([]),
    gatewayEvent: table(over.events ?? []),
    incident: table(over.incidents ?? []),
    ticket: table(over.tickets ?? []),
  } as unknown as ReportDb;
}
const incident = (o: Record<string, unknown>) => ({
  orgId: ORG,
  roomId: R1,
  kind: 'device_offline',
  severity: 'warning',
  title: 'Projector stopped answering',
  status: 'resolved',
  ...o,
});

describe('choosing the month', () => {
  it('is the month before now, in the zone', () => {
    expect(previousMonth(new Date('2026-10-01T02:00:00Z'), 'UTC')).toEqual({ year: 2026, month: 9 });
    expect(previousMonth(new Date('2026-01-15T00:00:00Z'), 'UTC')).toEqual({ year: 2025, month: 12 });
    // Already October on the 30 September UTC evening in Sydney.
    expect(previousMonth(new Date('2026-09-30T20:00:00Z'), 'Australia/Sydney')).toEqual({ year: 2026, month: 9 });
  });
});

describe('a monthly report', () => {
  it('counts hours in use and the rooms', async () => {
    const db = world({
      events: [status(R1, '2026-09-10T09:00:00Z', 'on'), status(R1, '2026-09-10T11:00:00Z', 'off')],
    });
    const r = await buildMonthlyReport(db, ORG, SEPT, 'UTC', NOW);
    expect(r.orgName).toBe('Acme');
    expect(r.label).toBe('September 2026');
    expect(r.summary).toMatchObject({ rooms: 2, hoursInUse: 2, sessions: 1 });
    expect(r.from).toBe('2026-09-01T00:00:00.000Z');
    expect(r.to).toBe('2026-10-01T00:00:00.000Z');
  });

  it('adds up downtime per room, counting overlapping outages once', async () => {
    const db = world({
      incidents: [
        incident({ id: 'a', openedAt: at('2026-09-05T10:00:00Z'), resolvedAt: at('2026-09-05T12:00:00Z'), subject: 'x' }),
        // Overlaps the first by an hour: 10:00 to 13:00 in all.
        incident({ id: 'b', openedAt: at('2026-09-05T11:00:00Z'), resolvedAt: at('2026-09-05T13:00:00Z'), subject: 'y' }),
        incident({ id: 'c', roomId: R2, openedAt: at('2026-09-06T00:00:00Z'), resolvedAt: at('2026-09-06T00:30:00Z'), subject: 'z' }),
      ],
    });
    const r = await buildMonthlyReport(db, ORG, SEPT, 'UTC', NOW);
    const boardroom = r.availability.find((a) => a.name === 'Boardroom')!;
    expect(boardroom.downtimeMinutes).toBe(180);
    expect(boardroom.availability).toBeCloseTo(1 - 180 / 43200);
    expect(r.summary.downtimeMinutes).toBe(210);
    expect(r.summary.incidentsOpened).toBe(3);
    expect(r.summary.incidentsResolved).toBe(3);
    // 120, 120 and 30 minutes.
    expect(r.summary.avgResolveMinutes).toBe(90);
    // The room with the most downtime is listed first.
    expect(r.availability[0]!.name).toBe('Boardroom');
    expect(r.incidents[0]!.minutes).toBe(120);
  });

  it('cuts an incident that spans the month boundary to the part inside', async () => {
    const db = world({
      incidents: [
        incident({ id: 'a', openedAt: at('2026-08-31T22:00:00Z'), resolvedAt: at('2026-09-01T02:00:00Z'), subject: 'x' }),
        incident({ id: 'b', openedAt: at('2026-09-30T23:00:00Z'), resolvedAt: at('2026-10-01T05:00:00Z'), subject: 'y', roomId: R2 }),
      ],
    });
    const r = await buildMonthlyReport(db, ORG, SEPT, 'UTC', NOW);
    expect(r.availability.find((a) => a.name === 'Boardroom')!.downtimeMinutes).toBe(120);
    expect(r.availability.find((a) => a.name === 'Annex')!.downtimeMinutes).toBe(60);
    // Opened before the month, so not counted as opened in it; resolved inside it, so counted as resolved.
    expect(r.summary.incidentsOpened).toBe(1);
    expect(r.summary.incidentsResolved).toBe(1);
  });

  it('counts an incident still open to the end of the month', async () => {
    const db = world({
      incidents: [incident({ id: 'a', status: 'open', openedAt: at('2026-09-30T00:00:00Z'), resolvedAt: null, subject: 'x' })],
    });
    const r = await buildMonthlyReport(db, ORG, SEPT, 'UTC', NOW);
    expect(r.summary.downtimeMinutes).toBe(1440);
    expect(r.summary.incidentsResolved).toBe(0);
    expect(r.incidents[0]!.resolvedAt).toBeNull();
  });

  it('does not count warnings that are not outages as downtime, and gateway outages separately', async () => {
    const db = world({
      incidents: [
        incident({ id: 'a', kind: 'deploy_failed', openedAt: at('2026-09-05T10:00:00Z'), resolvedAt: at('2026-09-05T12:00:00Z'), subject: 'x' }),
        incident({ id: 'b', kind: 'gateway_offline', roomId: null, openedAt: at('2026-09-07T10:00:00Z'), resolvedAt: at('2026-09-07T11:00:00Z'), subject: 'y' }),
      ],
    });
    const r = await buildMonthlyReport(db, ORG, SEPT, 'UTC', NOW);
    expect(r.summary.downtimeMinutes).toBe(60);
    expect(r.availability.every((a) => a.downtimeMinutes === 0)).toBe(true);
    expect(r.incidentsByKind).toEqual(expect.arrayContaining([{ kind: 'deploy_failed', count: 1 }, { kind: 'gateway_offline', count: 1 }]));
  });

  it('counts tickets opened and closed in the month, and those still open', async () => {
    const db = world({
      tickets: [
        { orgId: ORG, status: 'closed', createdAt: at('2026-09-02T00:00:00Z'), closedAt: at('2026-09-03T00:00:00Z') },
        { orgId: ORG, status: 'closed', createdAt: at('2026-08-20T00:00:00Z'), closedAt: at('2026-09-04T00:00:00Z') },
        { orgId: ORG, status: 'open', createdAt: at('2026-09-20T00:00:00Z'), closedAt: null },
        { orgId: ORG, status: 'closed', createdAt: at('2026-07-01T00:00:00Z'), closedAt: at('2026-07-02T00:00:00Z') },
      ],
    });
    const r = await buildMonthlyReport(db, ORG, SEPT, 'UTC', NOW);
    expect(r.summary).toMatchObject({ ticketsOpened: 2, ticketsClosed: 2, ticketsOpenNow: 1 });
  });

  it('reports a month still under way up to now, and says when it is older than the history kept', async () => {
    const db = world();
    const now = new Date('2026-09-11T00:00:00Z');
    const running = await buildMonthlyReport(db, ORG, SEPT, 'UTC', now);
    expect(running.to).toBe(now.toISOString());
    expect(running.beyondRetention).toBe(false);
    const old = await buildMonthlyReport(db, ORG, { year: 2026, month: 5 }, 'UTC', now);
    expect(old.beyondRetention).toBe(true);
  });

  it('starts and ends the month at local midnight in the zone, across a clock change', async () => {
    // Sydney is UTC+10 until 4 October and UTC+11 (daylight saving) after, so October is 31 days
    // and 1 hour long in real time.
    const r = await buildMonthlyReport(world(), ORG, { year: 2026, month: 10 }, 'Australia/Sydney', new Date('2026-11-05T00:00:00Z'));
    expect(r.from).toBe('2026-09-30T14:00:00.000Z');
    expect(r.to).toBe('2026-10-31T13:00:00.000Z');
  });

  it('writes a plain text version', async () => {
    const db = world({
      events: [status(R1, '2026-09-10T09:00:00Z', 'on'), status(R1, '2026-09-10T11:00:00Z', 'off')],
      incidents: [incident({ id: 'a', openedAt: at('2026-09-05T10:00:00Z'), resolvedAt: at('2026-09-05T12:00:00Z'), subject: 'x' })],
    });
    const text = reportText(await buildMonthlyReport(db, ORG, SEPT, 'UTC', NOW), 'https://app.example/o/1/reports');
    expect(text).toContain('Acme: September 2026 report');
    expect(text).toContain('2 rooms, 2 hours in use across 1 sessions');
    expect(text).toContain('1 problems came up, 1 were resolved (average 2 h to resolve)');
    expect(text).toContain('Boardroom: available 99.7% (2 h out)');
    expect(text).toContain('Full report: https://app.example/o/1/reports');
  });
});
