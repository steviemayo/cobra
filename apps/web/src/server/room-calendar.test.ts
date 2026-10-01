import { describe, expect, it } from 'vitest';
import { generateSealKey, seal } from '@kestrel/crypto';
import { weekDays, weekEnd, weekStart } from '../lib/week';
import { deliverAlerts, type AlertDb, type Senders } from './alerts';
import { clearTokenCache, type Deps } from './calendar';
import { affectedMeetings, refreshSchedules, type ScheduleDb } from './room-schedule';
import { freeSlots, maintenanceClashes, roomWeek, type RoomCalendarDb } from './room-calendar';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222221';
const ROOM_A = '33333333-3333-4333-8333-333333333331';
const ROOM_B = '33333333-3333-4333-8333-333333333332';
const INC = '77777777-7777-4777-8777-777777777771';
const SYDNEY = 'Australia/Sydney';
const key = generateSealKey();
const NOW = new Date('2026-09-30T20:00:00Z'); // Thursday 1 Oct 06:00 in Sydney

describe('weeks in a site’s time zone', () => {
  it('runs Monday to Sunday and starts at local midnight', () => {
    const start = weekStart(NOW, SYDNEY);
    // Monday 28 Sep 00:00 AEST (UTC+10).
    expect(start.toISOString()).toBe('2026-09-27T14:00:00.000Z');
    const days = weekDays(start, SYDNEY);
    expect(days).toHaveLength(7);
    expect(days[0]!.start.toISOString()).toBe(start.toISOString());
  });

  it('copes with daylight saving starting on the Sunday', () => {
    const start = weekStart(NOW, SYDNEY);
    const days = weekDays(start, SYDNEY);
    // Sunday 4 Oct is only 23 hours long, and the next week begins at 00:00 AEDT (UTC+11).
    expect(days[6]!.end.getTime() - days[6]!.start.getTime()).toBe(23 * 3_600_000);
    expect(weekEnd(start, SYDNEY).toISOString()).toBe('2026-10-04T13:00:00.000Z');
    expect(weekStart(weekEnd(start, SYDNEY), SYDNEY).toISOString()).toBe(
      '2026-10-04T13:00:00.000Z',
    );
  });

  it('puts a Sunday evening in the week that is ending', () => {
    // Sunday 27 Sep 23:30 AEST.
    expect(weekStart(new Date('2026-09-27T13:30:00Z'), SYDNEY).toISOString()).toBe(
      '2026-09-20T14:00:00.000Z',
    );
  });
});

describe('free times for maintenance', () => {
  const at = (iso: string) => new Date(iso);
  it('skips meetings and keeps to working hours', () => {
    // Thursday 1 Oct, 09:00-10:30 Sydney is booked.
    const booked = [{ start: '2026-09-30T23:00:00.000Z', end: '2026-10-01T00:30:00.000Z' }];
    const slots = freeSlots(booked, 3_600_000, at('2026-09-30T20:00:00Z'), SYDNEY);
    expect(slots).toHaveLength(3);
    for (const s of slots) {
      const e = s.getTime() + 3_600_000;
      expect(booked.some((b) => Date.parse(b.start) < e && Date.parse(b.end) > s.getTime())).toBe(
        false,
      );
    }
    // The first suggestion is 06:00 Sydney, the earliest working time.
    expect(slots[0]!.toISOString()).toBe('2026-09-30T20:00:00.000Z');
    expect(slots[1]!.getTime() - slots[0]!.getTime()).toBeGreaterThanOrEqual(2 * 3_600_000);
  });
});

const graph = { tenantId: 't1', clientId: 'c1', clientSecret: 's' };
const graph2 = { tenantId: 't2', clientId: 'c2', clientSecret: 's' };
const ev = (id: string, fromMs: number, toMs: number, extra: Record<string, unknown> = {}) => ({
  id,
  subject: `Subject ${id}`,
  organizer: { emailAddress: { name: 'Sam Lee', address: 'sam@example.com' } },
  isCancelled: false,
  isAllDay: false,
  sensitivity: 'normal',
  start: { dateTime: new Date(NOW.getTime() + fromMs).toISOString().replace('Z', '0000') },
  end: { dateTime: new Date(NOW.getTime() + toMs).toISOString().replace('Z', '0000') },
  ...extra,
});

function fakeFetch(events: unknown[], fail = false) {
  const calls: string[] = [];
  const f = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const reply = (body: unknown, code = 200) =>
      new Response(JSON.stringify(body), { status: code });
    if (url.includes('login.microsoftonline.com'))
      return reply({ access_token: 't', expires_in: 3600 });
    return fail ? reply({}, 503) : reply({ value: events });
  }) as typeof fetch;
  return { f, calls };
}
const deps = (f: typeof fetch): Deps => ({ fetch: f, secretsKey: key });

function world() {
  const calendarConnection = table([
    {
      id: 'p1',
      orgId: ORG,
      provider: 'graph',
      name: 'HQ tenant',
      sealed: seal(JSON.stringify(graph), key),
    },
    {
      id: 'p2',
      orgId: ORG,
      provider: 'graph',
      name: 'Branch tenant',
      sealed: seal(JSON.stringify(graph2), key),
    },
  ]);
  const room = table([
    {
      id: ROOM_A,
      orgId: ORG,
      siteId: SITE,
      name: 'Boardroom',
      calendarConnectionId: 'p1',
      calendarResource: 'board@hq.example.com',
    },
    {
      id: ROOM_B,
      orgId: ORG,
      siteId: SITE,
      name: 'Studio',
      calendarConnectionId: 'p2',
      calendarResource: 'studio@branch.example.com',
    },
  ]);
  const site = table([{ id: SITE, orgId: ORG, name: 'HQ', timezone: SYDNEY }]);
  const roomSchedule = table([]);
  const maintenanceWindow = table([]);
  const device = table([]);
  const release = table([]);
  return { calendarConnection, room, site, roomSchedule, maintenanceWindow, device, release };
}

describe('several calendar profiles', () => {
  it('reads each room with the profile it chose, even for the same service', async () => {
    clearTokenCache();
    const w = world();
    const { f, calls } = fakeFetch([ev('a', 3_600_000, 7_200_000)]);
    const out = await refreshSchedules(w as unknown as ScheduleDb, NOW, deps(f));
    expect(out.errors).toEqual([]);
    expect(out.checked).toBe(2);
    // One sign-in per tenant, and each room's own address was read.
    expect(calls.filter((c) => c.includes('login.microsoftonline.com/t1'))).toHaveLength(1);
    expect(calls.filter((c) => c.includes('login.microsoftonline.com/t2'))).toHaveLength(1);
    expect(calls.some((c) => c.includes(encodeURIComponent('board@hq.example.com')))).toBe(true);
    expect(calls.some((c) => c.includes(encodeURIComponent('studio@branch.example.com')))).toBe(
      true,
    );
    expect(w.roomSchedule.rows).toHaveLength(2);
  });

  it('skips a room with no calendar chosen', async () => {
    clearTokenCache();
    const w = world();
    w.room.rows[1]!.calendarConnectionId = null;
    const { f } = fakeFetch([]);
    const out = await refreshSchedules(w as unknown as ScheduleDb, NOW, deps(f));
    expect(out.checked).toBe(1);
    expect(w.roomSchedule.rows.map((r) => r.roomId)).toEqual([ROOM_A]);
  });
});

describe('the week view', () => {
  it('shows private meetings as busy and adds maintenance windows', async () => {
    clearTokenCache();
    const w = world();
    w.maintenanceWindow.rows.push({
      id: 'w1',
      orgId: ORG,
      name: 'Firmware',
      scope: 'room',
      scopeId: ROOM_A,
      startsAt: new Date(NOW.getTime() + 24 * 3_600_000),
      endsAt: new Date(NOW.getTime() + 26 * 3_600_000),
      repeat: 'none',
      repeatUntil: null,
    });
    const { f } = fakeFetch([
      ev('open', 3_600_000, 7_200_000),
      ev('secret', 7_200_000, 9_000_000, { sensitivity: 'private' }),
    ]);
    const view = await roomWeek(
      w as unknown as RoomCalendarDb,
      w.room.rows[0] as never,
      NOW,
      deps(f),
      NOW,
    );
    expect(view.source).toBe('live');
    expect(view.timezone).toBe(SYDNEY);
    expect(view.days).toHaveLength(7);
    expect(view.meetings.map((m) => [m.title, m.busy])).toEqual([
      ['Subject open', false],
      ['', true],
    ]);
    expect(JSON.stringify(view)).not.toContain('Subject secret');
    expect(view.windows.map((x) => x.name)).toEqual(['Firmware']);
  });

  it('falls back to the saved copy when the calendar can’t be reached', async () => {
    clearTokenCache();
    const w = world();
    w.roomSchedule.rows.push({
      roomId: ROOM_A,
      orgId: ORG,
      fetchedAt: NOW,
      meetings: [
        {
          id: 'x',
          title: 'Saved',
          start: new Date(NOW.getTime() + 3_600_000).toISOString(),
          end: new Date(NOW.getTime() + 7_200_000).toISOString(),
          private: false,
        },
      ],
    });
    const { f } = fakeFetch([], true);
    const view = await roomWeek(
      w as unknown as RoomCalendarDb,
      w.room.rows[0] as never,
      NOW,
      deps(f),
      NOW,
    );
    expect(view.source).toBe('copy');
    expect(view.problem).toMatch(/503/);
    expect(view.meetings[0]!.title).toBe('Saved');
  });

  it('says a room with no calendar is not configured', async () => {
    const w = world();
    const view = await roomWeek(
      w as unknown as RoomCalendarDb,
      {
        ...(w.room.rows[0] as object),
        calendarConnectionId: null,
        calendarResource: null,
      } as never,
      NOW,
      deps(fakeFetch([]).f),
      NOW,
    );
    expect(view).toMatchObject({ configured: false, source: 'none', meetings: [] });
  });
});

const saved = (w: ReturnType<typeof world>, fetchedAt = NOW) =>
  w.roomSchedule.rows.push({
    roomId: ROOM_A,
    orgId: ORG,
    fetchedAt,
    meetings: [
      {
        id: 'm1',
        title: 'Board',
        organiser: 'Ann',
        start: new Date(NOW.getTime() + 3_600_000).toISOString(),
        end: new Date(NOW.getTime() + 7_200_000).toISOString(),
        private: false,
      },
      {
        id: 'm2',
        title: 'Secret',
        organiser: 'Bob',
        start: new Date(NOW.getTime() + 2 * 3_600_000).toISOString(),
        end: new Date(NOW.getTime() + 3 * 3_600_000).toISOString(),
        private: true,
      },
      {
        id: 'm3',
        title: 'Far off',
        start: new Date(NOW.getTime() + 30 * 3_600_000).toISOString(),
        end: new Date(NOW.getTime() + 31 * 3_600_000).toISOString(),
        private: false,
      },
    ],
  });

describe('meetings a fault may affect', () => {
  it('lists what is on now or starts within 12 hours, hiding private details', async () => {
    const w = world();
    saved(w);
    const out = await affectedMeetings(w as never, ORG, ROOM_A, NOW);
    expect(out.meetings.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(out.meetings[1]).toMatchObject({ title: '' });
    expect(out.meetings[1]!.organiser).toBeUndefined();
  });

  it('says nothing when the copy is stale', async () => {
    const w = world();
    saved(w, new Date(NOW.getTime() - 3_600_000));
    expect((await affectedMeetings(w as never, ORG, ROOM_A, NOW)).meetings).toEqual([]);
  });
});

describe('maintenance clashes', () => {
  const plan = (from: number, to: number, scope = 'room', scopeId: string | null = ROOM_A) => ({
    scope,
    scopeId,
    startsAt: new Date(NOW.getTime() + from),
    endsAt: new Date(NOW.getTime() + to),
  });

  it('reports meetings in the covered room and suggests free times', async () => {
    const w = world();
    saved(w);
    const out = await maintenanceClashes(
      w as unknown as RoomCalendarDb,
      ORG,
      plan(3_600_000 + 600_000, 2.5 * 3_600_000),
      NOW,
    );
    expect(out.clashes.map((c) => c.meeting.id)).toEqual(['m1', 'm2']);
    expect(out.clashes[1]!.meeting.busy).toBe(true);
    expect(out.clashes[1]!.meeting.title).toBe('');
    expect(out.checked).toBe(1);
    expect(out.suggestions.length).toBeGreaterThan(0);
  });

  it('finds nothing when the time is free, and counts rooms without a calendar', async () => {
    const w = world();
    saved(w);
    const out = await maintenanceClashes(
      w as unknown as RoomCalendarDb,
      ORG,
      plan(10 * 3_600_000, 11 * 3_600_000, 'site', SITE),
      NOW,
    );
    expect(out.clashes).toEqual([]);
    expect(out.rooms).toBe(2);
    expect(out.checked).toBe(1);
  });
});

describe('fault alerts', () => {
  it('carry the meetings the fault may affect', async () => {
    const w = world();
    saved(w);
    const sent: string[] = [];
    const s: Senders = {
      fetch: (async (_u: string | URL, init: RequestInit) => {
        sent.push(String(init.body));
        return new Response('{}');
      }) as typeof fetch,
      resolve: async () => ['93.184.216.34'],
      env: {},
    };
    const db = {
      ...w,
      alertChannel: table([
        {
          id: 'c1',
          orgId: ORG,
          enabled: true,
          minSeverity: 'warning',
          type: 'webhook',
          config: { url: 'https://hooks.example.com/x' },
        },
      ]),
      alertDelivery: table([]),
      incident: table([
        {
          id: INC,
          orgId: ORG,
          roomId: ROOM_A,
          kind: 'device_offline',
          severity: 'warning',
          title: 'DSP is offline',
          detail: null,
          openedAt: NOW,
          resolvedAt: null,
          acknowledgedAt: null,
        },
      ]),
    } as unknown as AlertDb;
    await deliverAlerts(db, [{ incidentId: INC, event: 'opened' }] as never, s, NOW);
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0]!);
    expect(body.incident.impact.meetings).toHaveLength(2);
    expect(body.incident.impact.lines[0]).toContain('Board');
    expect(body.incident.impact.lines[1]).toContain('Busy');
    expect(JSON.stringify(body)).not.toContain('Secret');
    expect(JSON.stringify(body)).not.toContain('Bob');
  });
});
