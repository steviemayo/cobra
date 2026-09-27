import { describe, expect, it } from 'vitest';
import { RoomModel } from '@kestrel/model';
import {
  MAX_USAGE_EVENTS,
  analyseRoom,
  buildReport,
  insightsFor,
  loadUsageReport,
  validTimeZone,
  type UsageDb,
  type UsageEvent,
  type UsageOptions,
} from './usage-analytics';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const ROOM = '33333333-3333-4333-8333-333333333331';
const SITE = '22222222-2222-4222-8222-222222222221';
const room = { roomId: ROOM, name: 'Boardroom', siteId: SITE };

// Monday 21 September 2026 to Saturday 26: five business days of ten hours (8:00 to 18:00).
const opts = (over: Partial<UsageOptions> = {}): UsageOptions => ({
  from: new Date('2026-09-21T00:00:00Z'),
  to: new Date('2026-09-26T00:00:00Z'),
  tz: 'UTC',
  businessStartHour: 8,
  businessEndHour: 18,
  ...over,
});
const status = (at: string, s: string): UsageEvent => ({ roomId: ROOM, type: 'room.status', at: new Date(at), data: { status: s } });
const occupied = (at: string, o: boolean): UsageEvent => ({ roomId: ROOM, type: 'room.occupancy', at: new Date(at), data: { occupied: o } });
const activity = (at: string, id: string): UsageEvent => ({ roomId: ROOM, type: 'activity.started', at: new Date(at), data: { activityId: id } });
const analyse = (events: UsageEvent[], o = opts(), names = new Map<string, string>()) => analyseRoom(room, events, o, names);

describe('time in use', () => {
  it('adds up the time a room was on, and how much of business hours that is', () => {
    const r = analyse([status('2026-09-21T00:00:00Z', 'off'), status('2026-09-22T09:00:00Z', 'on'), status('2026-09-22T11:00:00Z', 'off')]);
    expect(r.inUseMinutes).toBe(120);
    expect(r.businessInUseMinutes).toBe(120);
    expect(r.utilisation).toBeCloseTo(120 / 3000);
    expect(r.sessions).toBe(1);
    expect(r.avgSessionMinutes).toBe(120);
    expect(r.lastUsedAt).toBe('2026-09-22T11:00:00.000Z');
  });

  it('counts starting as in use, and time outside business hours only in the total', () => {
    const r = analyse([status('2026-09-22T06:00:00Z', 'starting'), status('2026-09-22T06:05:00Z', 'on'), status('2026-09-22T09:00:00Z', 'off')]);
    expect(r.inUseMinutes).toBe(180);
    expect(r.businessInUseMinutes).toBe(60);
  });

  it('does not count a weekend as business hours', () => {
    const r = analyse(
      [status('2026-09-19T00:00:00Z', 'off'), status('2026-09-20T09:00:00Z', 'on'), status('2026-09-20T11:00:00Z', 'off')],
      opts({ from: new Date('2026-09-19T00:00:00Z'), to: new Date('2026-09-22T00:00:00Z') }),
    );
    expect(r.inUseMinutes).toBe(120);
    expect(r.businessInUseMinutes).toBe(0);
  });

  it('carries a room that was already on when the range began', () => {
    const r = analyse([status('2026-09-20T22:00:00Z', 'on'), status('2026-09-21T10:00:00Z', 'off')]);
    expect(r.inUseMinutes).toBe(600);
  });

  it('counts a room still on at the end of the range up to the end', () => {
    const r = analyse([status('2026-09-25T20:00:00Z', 'on')]);
    expect(r.inUseMinutes).toBe(240);
  });

  it('does not treat the time before a room first reported as unused', () => {
    // First heard from on Wednesday: the window is Wednesday to Friday, three days of business hours.
    const r = analyse([status('2026-09-23T00:00:00Z', 'off'), status('2026-09-23T08:00:00Z', 'on'), status('2026-09-23T18:00:00Z', 'off')]);
    expect(r.utilisation).toBeCloseTo(600 / 1800);
    expect(r.coveredMinutes).toBe(3 * 1440);
  });

  it('has no utilisation for a room that never reported', () => {
    const r = analyse([]);
    expect(r.utilisation).toBeNull();
    expect(r.inUseMinutes).toBe(0);
    expect(r.sessions).toBe(0);
    expect(r.avgSessionMinutes).toBeNull();
    expect(r.lastUsedAt).toBeNull();
  });

  it('puts events in order and ignores ones with no status', () => {
    const r = analyse([
      status('2026-09-22T11:00:00Z', 'off'),
      status('2026-09-22T09:00:00Z', 'on'),
      { roomId: ROOM, type: 'room.status', at: new Date('2026-09-22T09:30:00Z'), data: {} },
    ]);
    expect(r.inUseMinutes).toBe(120);
  });
});

describe('occupancy', () => {
  it('splits time into on with someone in, on and empty, and occupied but off', () => {
    const r = analyse([
      status('2026-09-22T09:00:00Z', 'on'),
      status('2026-09-22T11:00:00Z', 'off'),
      occupied('2026-09-22T09:30:00Z', true),
      occupied('2026-09-22T11:30:00Z', false),
    ]);
    expect(r.hasOccupancy).toBe(true);
    expect(r.occupiedMinutes).toBe(120);
    expect(r.inUseEmptyMinutes).toBe(30);
    expect(r.occupiedIdleMinutes).toBe(30);
  });

  it('reports none of it for a room with no sensor', () => {
    const r = analyse([status('2026-09-22T09:00:00Z', 'on'), status('2026-09-22T11:00:00Z', 'off')]);
    expect(r.hasOccupancy).toBe(false);
    expect([r.occupiedMinutes, r.inUseEmptyMinutes, r.occupiedIdleMinutes]).toEqual([0, 0, 0]);
  });
});

describe('activities', () => {
  it('counts starts by activity, named from the design, busiest first', () => {
    const r = analyse(
      [
        activity('2026-09-22T09:00:00Z', 'present'),
        activity('2026-09-22T10:00:00Z', 'call'),
        activity('2026-09-23T10:00:00Z', 'present'),
        activity('2026-09-30T10:00:00Z', 'present'),
      ],
      opts(),
      new Map([['present', 'Present']]),
    );
    expect(r.activities).toEqual([
      { activityId: 'present', name: 'Present', count: 2 },
      { activityId: 'call', name: 'call', count: 1 },
    ]);
  });
});

describe('the whole report', () => {
  it('shows use by day of the week and hour, and by date, including quiet days', () => {
    const rep = buildReport([room], [status('2026-09-22T09:00:00Z', 'on'), status('2026-09-22T11:00:00Z', 'off')], new Map(), opts());
    expect(rep.heatmap[1]![9]).toBe(60);
    expect(rep.heatmap[1]![10]).toBe(60);
    expect(rep.heatmap[1]![11]).toBe(0);
    expect(rep.daily.map((d) => d.date)).toEqual(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25']);
    expect(rep.daily.find((d) => d.date === '2026-09-22')!.inUseMinutes).toBe(120);
  });

  it('reads days and hours in the chosen time zone', () => {
    // 23:00 UTC on Tuesday is 09:00 on Wednesday in Sydney (UTC+10 before daylight saving starts).
    const rep = buildReport([room], [status('2026-09-22T23:00:00Z', 'on'), status('2026-09-23T00:00:00Z', 'off')], new Map(), opts({ tz: 'Australia/Sydney' }));
    expect(rep.heatmap[2]![9]).toBe(60);
    expect(rep.daily.find((d) => d.date === '2026-09-23')!.inUseMinutes).toBe(60);
  });

  it('adds the same activity up across rooms and ranks rooms by use', () => {
    const other = { roomId: 'r2', name: 'Annex', siteId: SITE };
    const events = [
      status('2026-09-22T09:00:00Z', 'on'),
      status('2026-09-22T10:00:00Z', 'off'),
      activity('2026-09-22T09:00:00Z', 'present'),
      { roomId: 'r2', type: 'room.status', at: new Date('2026-09-22T09:00:00Z'), data: { status: 'on' } },
      { roomId: 'r2', type: 'room.status', at: new Date('2026-09-22T15:00:00Z'), data: { status: 'off' } },
      { roomId: 'r2', type: 'activity.started', at: new Date('2026-09-22T09:00:00Z'), data: { activityId: 'present' } },
    ];
    const names = new Map([
      [ROOM, new Map([['present', 'Present']])],
      ['r2', new Map([['present', 'Present']])],
    ]);
    const rep = buildReport([room, other], events, names, opts());
    expect(rep.rooms.map((r) => r.name)).toEqual(['Annex', 'Boardroom']);
    expect(rep.activities).toEqual([{ activityId: 'present', name: 'Present', count: 2 }]);
  });
});

describe('insights', () => {
  const base = analyse([]);
  it('points out a room that is on with nobody in it', () => {
    const r = { ...base, hasOccupancy: true, inUseMinutes: 600, inUseEmptyMinutes: 300 };
    expect(insightsFor([r])).toEqual([
      expect.objectContaining({ kind: 'in_use_empty', text: expect.stringContaining('nobody in it for 5 h (50%') }),
    ]);
  });
  it('points out people in a room without using it', () => {
    const r = { ...base, hasOccupancy: true, occupiedMinutes: 600, occupiedIdleMinutes: 400 };
    expect(insightsFor([r]).map((i) => i.kind)).toEqual(['occupied_idle']);
  });
  it('flags rooms that are barely used or very busy, but only with enough days of data', () => {
    const long = { ...base, coveredMinutes: 5 * 1440 };
    expect(insightsFor([{ ...long, utilisation: 0.04 }]).map((i) => i.kind)).toEqual(['underused']);
    expect(insightsFor([{ ...long, utilisation: 0.8 }]).map((i) => i.kind)).toEqual(['busy']);
    expect(insightsFor([{ ...base, coveredMinutes: 1440, utilisation: 0.01 }])).toEqual([]);
  });
  it('says nothing for small amounts', () => {
    const r = { ...base, hasOccupancy: true, inUseMinutes: 30, inUseEmptyMinutes: 30 };
    expect(insightsFor([r])).toEqual([]);
  });
});

describe('time zones', () => {
  it('knows real zones and refuses made-up ones', () => {
    expect(validTimeZone('Australia/Sydney')).toBe(true);
    expect(validTimeZone('Mars/Base')).toBe(false);
  });
});

describe('loading a report', () => {
  const world = (
    events: Record<string, unknown>[],
    rooms = [{ id: ROOM, orgId: ORG, siteId: SITE, name: 'Boardroom' }],
  ) => {
    const model = RoomModel.parse({
      roomType: 'meeting',
      devices: [],
      activities: [{ id: 'present', name: 'Present', kind: 'present' }],
    });
    return {
      room: table(rooms),
      gatewayEvent: table(events.map((e) => ({ orgId: ORG, ...e }))),
      roomDraft: table([{ orgId: ORG, roomId: ROOM, model }]),
    } as unknown as UsageDb;
  };

  it('reads events and the state each room began in, and names activities from the design', async () => {
    const db = world([
      { roomId: ROOM, type: 'room.status', at: new Date('2026-09-20T22:00:00Z'), data: { status: 'on' } },
      { roomId: ROOM, type: 'room.status', at: new Date('2026-09-21T10:00:00Z'), data: { status: 'off' } },
      { roomId: ROOM, type: 'activity.started', at: new Date('2026-09-21T09:00:00Z'), data: { activityId: 'present' } },
    ]);
    const rep = await loadUsageReport(db, ORG, opts());
    expect(rep.rooms[0]).toMatchObject({ name: 'Boardroom', inUseMinutes: 600, sessions: 1 });
    expect(rep.activities).toEqual([{ activityId: 'present', name: 'Present', count: 1 }]);
    expect(rep.truncated).toBe(false);
  });

  it('is empty for an organisation with no rooms', async () => {
    const rep = await loadUsageReport(world([], []), ORG, opts());
    expect(rep.rooms).toEqual([]);
    expect(rep.heatmap).toHaveLength(7);
  });

  it('says so when there was more than could be read', async () => {
    const many = Array.from({ length: MAX_USAGE_EVENTS + 1 }, (_, i) => ({
      roomId: ROOM,
      type: 'activity.started',
      at: new Date(Date.parse('2026-09-21T00:00:00Z') + i),
      data: { activityId: 'present' },
    }));
    const rep = await loadUsageReport(world(many), ORG, opts());
    expect(rep.truncated).toBe(true);
  });
});
