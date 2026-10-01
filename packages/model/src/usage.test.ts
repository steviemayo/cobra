import { describe, expect, it } from 'vitest';
import {
  DEFAULT_USAGE_RULES,
  DEFAULT_WORKING_HOURS,
  checkUsageRule,
  computeSessions,
  countWorkingDays,
  describeUsageRule,
  evaluateUsageRule,
  summariseUsage,
  availableWorkMinutes,
  utilisation,
  type ReadingEvent,
  type UsageRule,
} from './usage';

const devices = [
  { id: 'd1', category: 'display' },
  { id: 'd2', category: 'occupancy_sensor' },
  { id: 'd3', category: 'video_source' },
];
const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 29, 22, 0); // 08:00 on Wed 30 Sep in Sydney (UTC+10)
const ev = (at: number, deviceId: string, field: string, value: string): ReadingEvent => ({
  at,
  deviceId,
  field,
  value,
});

describe('evaluateUsageRule', () => {
  const lookup = (m: Record<string, string>) => (d: string, f: string) => m[`${d}|${f}`];
  const rule: UsageRule = {
    op: 'or',
    rules: [
      { op: 'cond', category: 'display', field: 'power', cmp: 'eq', value: 'on' },
      { op: 'cond', category: 'occupancy_sensor', field: 'occupied', cmp: 'eq', value: true },
      { op: 'cond', category: 'video_source', field: 'signal', cmp: 'present' },
    ],
  };

  it('is true when any part of an OR holds', () => {
    expect(evaluateUsageRule(rule, devices, lookup({ 'd1|power': 'on' }))).toBe(true);
    expect(evaluateUsageRule(rule, devices, lookup({ 'd2|occupied': 'true' }))).toBe(true);
    expect(evaluateUsageRule(rule, devices, lookup({ 'd3|signal': 'true' }))).toBe(true);
    expect(evaluateUsageRule(rule, devices, lookup({ 'd1|power': 'off' }))).toBe(false);
    expect(evaluateUsageRule(rule, devices, lookup({}))).toBe(false);
  });

  it('supports AND, NOT, comparisons and a single named device', () => {
    const r: UsageRule = {
      op: 'and',
      rules: [
        { op: 'cond', deviceId: 'd1', field: 'volume', cmp: 'gt', value: 10 },
        { op: 'not', rule: { op: 'cond', deviceId: 'd1', field: 'muted', cmp: 'eq', value: true } },
      ],
    };
    expect(evaluateUsageRule(r, devices, lookup({ 'd1|volume': '40', 'd1|muted': 'false' }))).toBe(
      true,
    );
    expect(evaluateUsageRule(r, devices, lookup({ 'd1|volume': '40', 'd1|muted': 'true' }))).toBe(
      false,
    );
    expect(evaluateUsageRule(r, devices, lookup({ 'd1|volume': '5' }))).toBe(false);
  });

  it('treats off and false as not present', () => {
    const r: UsageRule = { op: 'cond', category: 'video_source', field: 'signal', cmp: 'present' };
    expect(evaluateUsageRule(r, devices, lookup({ 'd3|signal': 'false' }))).toBe(false);
  });
});

describe('checkUsageRule and describeUsageRule', () => {
  it('refuses conditions that name nothing and rules that are too deep', () => {
    expect(checkUsageRule({ op: 'cond', field: 'power', cmp: 'eq', value: 'on' })).toMatch(
      /device/,
    );
    expect(checkUsageRule({ op: 'cond', category: 'display', field: 'power', cmp: 'eq' })).toMatch(
      /value/,
    );
    let deep: UsageRule = { op: 'cond', category: 'display', field: 'power', cmp: 'present' };
    for (let i = 0; i < 8; i++) deep = { op: 'not', rule: deep };
    expect(checkUsageRule(deep)).toMatch(/deeply/);
    expect(checkUsageRule(DEFAULT_USAGE_RULES.av)).toBeNull();
  });

  it('reads the rule back in words', () => {
    const text = describeUsageRule(DEFAULT_USAGE_RULES.occupied, (c) => c.category ?? '');
    expect(text).toBe('occupancy_sensor occupied is true');
  });
});

describe('computeSessions', () => {
  const rule: UsageRule = {
    op: 'cond',
    category: 'display',
    field: 'power',
    cmp: 'eq',
    value: 'on',
  };
  const base = { devices, rule, holdOffMs: 3 * MIN, minOnMs: MIN };

  it('finds a session from on to off', () => {
    const s = computeSessions({
      ...base,
      events: [ev(T0 + 10 * MIN, 'd1', 'power', 'on'), ev(T0 + 70 * MIN, 'd1', 'power', 'off')],
      from: T0,
      to: T0 + 240 * MIN,
    });
    expect(s).toEqual([{ start: T0 + 10 * MIN, end: T0 + 70 * MIN }]);
  });

  it('starts the window inside a session using the reading already in force', () => {
    const s = computeSessions({
      ...base,
      events: [ev(T0 - 30 * MIN, 'd1', 'power', 'on'), ev(T0 + 20 * MIN, 'd1', 'power', 'off')],
      from: T0,
      to: T0 + 60 * MIN,
    });
    expect(s).toEqual([{ start: T0, end: T0 + 20 * MIN }]);
  });

  it('runs a session that is still on to the end of the window', () => {
    const s = computeSessions({
      ...base,
      events: [ev(T0 + 5 * MIN, 'd1', 'power', 'on')],
      from: T0,
      to: T0 + 30 * MIN,
    });
    expect(s).toEqual([{ start: T0 + 5 * MIN, end: T0 + 30 * MIN }]);
  });

  it('does not let a short gap end a session, and drops very short sessions', () => {
    const s = computeSessions({
      ...base,
      events: [
        ev(T0, 'd1', 'power', 'on'),
        ev(T0 + 30 * MIN, 'd1', 'power', 'off'),
        ev(T0 + 32 * MIN, 'd1', 'power', 'on'), // a 2 minute gap: same session
        ev(T0 + 60 * MIN, 'd1', 'power', 'off'),
        ev(T0 + 120 * MIN, 'd1', 'power', 'on'),
        ev(T0 + 120 * MIN + 30_000, 'd1', 'power', 'off'), // 30 seconds: too short
      ],
      from: T0 - MIN,
      to: T0 + 200 * MIN,
    });
    expect(s).toEqual([{ start: T0, end: T0 + 60 * MIN }]);
  });

  it('joins several signals with OR: occupied keeps the room in use after the screen goes off', () => {
    const both: UsageRule = {
      op: 'or',
      rules: [DEFAULT_USAGE_RULES.av, DEFAULT_USAGE_RULES.occupied],
    };
    const s = computeSessions({
      ...base,
      rule: both,
      events: [
        ev(T0, 'd1', 'power', 'on'),
        ev(T0 + 10 * MIN, 'd2', 'occupied', 'true'),
        ev(T0 + 20 * MIN, 'd1', 'power', 'off'),
        ev(T0 + 50 * MIN, 'd2', 'occupied', 'false'),
      ],
      from: T0 - MIN,
      to: T0 + 100 * MIN,
    });
    expect(s).toEqual([{ start: T0, end: T0 + 50 * MIN }]);
  });

  it('gives a different answer for a changed rule over the same history (recompute)', () => {
    const events = [
      ev(T0, 'd1', 'power', 'on'),
      ev(T0 + 10 * MIN, 'd2', 'occupied', 'true'),
      ev(T0 + 20 * MIN, 'd1', 'power', 'off'),
      ev(T0 + 60 * MIN, 'd2', 'occupied', 'false'),
    ];
    const window = { from: T0 - MIN, to: T0 + 100 * MIN };
    const av = computeSessions({ ...base, events, ...window });
    const occ = computeSessions({ ...base, rule: DEFAULT_USAGE_RULES.occupied, events, ...window });
    expect(av).toEqual([{ start: T0, end: T0 + 20 * MIN }]);
    expect(occ).toEqual([{ start: T0 + 10 * MIN, end: T0 + 60 * MIN }]);
  });
});

describe('summariseUsage', () => {
  const tz = 'Australia/Sydney';

  it('splits by the local clock and counts working and after-hours time', () => {
    // Wed 30 Sep 2026: 07:30 to 09:30 local, of which 08:00 to 09:30 is working time.
    const start = Date.UTC(2026, 8, 29, 21, 30);
    const s = summariseUsage([{ start, end: start + 120 * MIN }], tz, DEFAULT_WORKING_HOURS);
    expect(s.days).toHaveLength(1);
    expect(s.days[0]).toMatchObject({
      day: '2026-09-30',
      minutes: 120,
      workMinutes: 90,
      sessions: 1,
      longestMinutes: 120,
    });
    expect(s.afterHoursMinutes).toBe(30);
    expect(s.days[0]!.hours[7]).toBe(30);
    expect(s.days[0]!.hours[8]).toBe(60);
    expect(s.heat[3]![8]).toBe(60); // Wednesday
    expect(s.sessions).toBe(1);
    expect(s.averageMinutes).toBe(120);
  });

  it('counts a weekend session as after hours', () => {
    // Sat 3 Oct 2026, 10:00 local.
    const start = Date.UTC(2026, 9, 3, 0, 0);
    const s = summariseUsage([{ start, end: start + 60 * MIN }], tz, DEFAULT_WORKING_HOURS);
    expect(s.workMinutes).toBe(0);
    expect(s.afterHoursMinutes).toBe(60);
  });

  it('gives utilisation as a share of working time', () => {
    const start = Date.UTC(2026, 8, 29, 22, 0);
    const s = summariseUsage([{ start, end: start + 300 * MIN }], tz, DEFAULT_WORKING_HOURS);
    // 5 of 10 working hours on the one working day.
    expect(utilisation(s, 600)).toBeCloseTo(0.5);
    expect(utilisation(s, 0)).toBeNull();
  });

  it('counts the working minutes inside a window, part days included', () => {
    // Wed 30 Sep 2026 from 07:00 to 12:00 local: 4 working hours (08:00 to 12:00).
    const from = Date.UTC(2026, 8, 29, 21, 0);
    expect(availableWorkMinutes(from, from + 300 * MIN, tz, DEFAULT_WORKING_HOURS)).toBe(240);
    // A whole weekend is nothing.
    const sat = Date.UTC(2026, 9, 2, 14, 0);
    expect(availableWorkMinutes(sat, sat + 48 * 60 * MIN, tz, DEFAULT_WORKING_HOURS)).toBe(0);
    // A whole working day is ten hours.
    const wed = Date.UTC(2026, 8, 29, 14, 0);
    expect(availableWorkMinutes(wed, wed + 24 * 60 * MIN, tz, DEFAULT_WORKING_HOURS)).toBe(600);
  });

  it('counts working days in a range', () => {
    const from = Date.UTC(2026, 8, 27, 14, 0); // Mon 28 Sep local
    const to = Date.UTC(2026, 9, 3, 13, 59); // through Sat 3 Oct local (before daylight saving starts)
    expect(countWorkingDays(from, to, tz, DEFAULT_WORKING_HOURS)).toBe(5);
  });

  it('falls back to UTC for an unknown time zone', () => {
    const start = Date.UTC(2026, 8, 30, 9, 0);
    const s = summariseUsage(
      [{ start, end: start + 60 * MIN }],
      'Not/AZone',
      DEFAULT_WORKING_HOURS,
    );
    expect(s.days[0]!.day).toBe('2026-09-30');
  });
});
