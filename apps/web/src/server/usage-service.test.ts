import { describe, expect, it } from 'vitest';
import {
  deviceHistoryView,
  estateUsage,
  getDefinition,
  loadWorkingHours,
  pruneUsage,
  resetDefinition,
  rollupUsage,
  roomUsage,
  saveDefinition,
  saveWorkingHours,
  usageInsights,
  type UsageDb,
} from './usage-service';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const ROOM = '33333333-3333-4333-8333-333333333331';
const ROOM2 = '33333333-3333-4333-8333-333333333332';
const DISPLAY = '44444444-4444-4444-8444-444444444441';
const SENSOR = '44444444-4444-4444-8444-444444444442';
const MIN = 60_000;
// Wed 30 Sep 2026, 08:00 in Sydney (UTC+10).
const T0 = Date.UTC(2026, 8, 29, 22, 0);
const NOW = new Date(T0 + 12 * 60 * MIN);
const h = (offsetMin: number, deviceId: string, field: string, value: string) => ({
  orgId: ORG,
  deviceId,
  roomId: ROOM,
  field,
  value,
  at: new Date(T0 + offsetMin * MIN),
});

function world() {
  const room = table([
    { id: ROOM, orgId: ORG, siteId: SITE, name: 'Boardroom' },
    { id: ROOM2, orgId: ORG, siteId: SITE, name: 'Studio' },
  ]);
  const site = table([{ id: SITE, orgId: ORG, timezone: 'Australia/Sydney' }]);
  const device = table([
    {
      id: DISPLAY,
      orgId: ORG,
      roomId: ROOM,
      kind: 'active',
      category: 'display',
      online: true,
      feedback: { power: 'on' },
    },
    {
      id: SENSOR,
      orgId: ORG,
      roomId: ROOM,
      kind: 'active',
      category: 'occupancy_sensor',
      online: true,
      feedback: {},
    },
    {
      id: 'lonely',
      orgId: ORG,
      roomId: ROOM2,
      kind: 'passive',
      category: 'display',
      online: null,
      feedback: null,
    },
  ]);
  const deviceHistory = table([]);
  const usageDefinition = table([]);
  const usageSettings = table([]);
  const roomUsageDay = table([]);
  const db = {
    room,
    site,
    device,
    deviceHistory,
    usageDefinition,
    usageSettings,
    roomUsageDay,
  } as unknown as UsageDb;
  return { db, deviceHistory, usageDefinition, usageSettings, roomUsageDay, device };
}

describe('definitions', () => {
  it('uses Kestrel rule, then the organisation rule, then the room own rule', async () => {
    const w = world();
    expect((await getDefinition(w.db, ORG, ROOM, 'av')).source).toBe('default');
    const rule = {
      op: 'cond',
      category: 'occupancy_sensor',
      field: 'occupied',
      cmp: 'eq',
      value: true,
    };
    await saveDefinition(w.db, {
      orgId: ORG,
      roomId: null,
      kind: 'av',
      rule,
      holdOffSeconds: 60,
      minOnSeconds: 30,
      userId: null,
    });
    expect(await getDefinition(w.db, ORG, ROOM, 'av')).toMatchObject({
      source: 'org',
      holdOffSeconds: 60,
      minOnSeconds: 30,
    });
    await saveDefinition(w.db, {
      orgId: ORG,
      roomId: ROOM,
      kind: 'av',
      rule,
      holdOffSeconds: 120,
      minOnSeconds: 10,
      userId: null,
    });
    expect(await getDefinition(w.db, ORG, ROOM, 'av')).toMatchObject({
      source: 'room',
      holdOffSeconds: 120,
    });
    await resetDefinition(w.db, ORG, ROOM, 'av');
    expect((await getDefinition(w.db, ORG, ROOM, 'av')).source).toBe('org');
  });

  it('refuses a rule that names nothing, and a room from another organisation', async () => {
    const w = world();
    const bad = await saveDefinition(w.db, {
      orgId: ORG,
      roomId: null,
      kind: 'av',
      rule: { op: 'cond', field: 'power', cmp: 'eq', value: 'on' },
      holdOffSeconds: 0,
      minOnSeconds: 0,
      userId: null,
    });
    expect(bad.ok).toBe(false);
    const rule = { op: 'cond', category: 'display', field: 'power', cmp: 'eq', value: 'on' };
    const other = await saveDefinition(w.db, {
      orgId: '99999999-9999-4999-8999-999999999999',
      roomId: ROOM,
      kind: 'av',
      rule,
      holdOffSeconds: 0,
      minOnSeconds: 0,
      userId: null,
    });
    expect(other).toMatchObject({ ok: false, message: 'No such room' });
  });

  it('keeps working hours and refuses nonsense', async () => {
    const w = world();
    expect((await loadWorkingHours(w.db, ORG)).start).toBe('08:00');
    expect(
      (await saveWorkingHours(w.db, ORG, { days: [1, 2, 3], start: '09:00', end: '17:30' })).ok,
    ).toBe(true);
    expect(await loadWorkingHours(w.db, ORG)).toEqual({
      days: [1, 2, 3],
      start: '09:00',
      end: '17:30',
    });
    expect(
      (await saveWorkingHours(w.db, ORG, { days: [1], start: '18:00', end: '08:00' })).ok,
    ).toBe(false);
    expect((await saveWorkingHours(w.db, ORG, { days: [], start: '08:00', end: '18:00' })).ok).toBe(
      false,
    );
  });
});

describe('roomUsage', () => {
  it('builds sessions from stored readings, and works out utilisation in working time', async () => {
    const w = world();
    // Display on 09:00 to 12:00 local, on the one working day in the window.
    await w.deviceHistory.createMany({
      data: [h(60, DISPLAY, 'power', 'on'), h(240, DISPLAY, 'power', 'off')],
    });
    const u = (await roomUsage(w.db, { orgId: ORG, roomId: ROOM, kind: 'av', days: 1, now: NOW }))!;
    expect(u.summary.sessions).toBe(1);
    expect(u.summary.totalMinutes).toBe(180);
    expect(u.summary.workMinutes).toBe(180);
    expect(u.utilisation).toBeCloseTo(0.3); // 3 of the 10 working hours in the window
    expect(u.inUseNow).toBe(true); // the display's latest feedback says on
    expect(u.monitoredDevices).toBe(2);
  });

  it('gives a different answer when the rule changes, over the same readings', async () => {
    const w = world();
    await w.deviceHistory.createMany({
      data: [
        h(60, DISPLAY, 'power', 'on'),
        h(120, SENSOR, 'occupied', 'true'),
        h(180, DISPLAY, 'power', 'off'),
        h(300, SENSOR, 'occupied', 'false'),
      ],
    });
    const av = (await roomUsage(w.db, {
      orgId: ORG,
      roomId: ROOM,
      kind: 'av',
      days: 1,
      now: NOW,
    }))!;
    const occupied = (await roomUsage(w.db, {
      orgId: ORG,
      roomId: ROOM,
      kind: 'occupied',
      days: 1,
      now: NOW,
    }))!;
    expect(av.summary.totalMinutes).toBe(120);
    expect(occupied.summary.totalMinutes).toBe(180);
  });

  it('carries a session in from before the window using the reading in force', async () => {
    const w = world();
    await w.deviceHistory.createMany({
      data: [h(-30, DISPLAY, 'power', 'on'), h(90, DISPLAY, 'power', 'off')],
    });
    const u = (await roomUsage(w.db, { orgId: ORG, roomId: ROOM, kind: 'av', days: 1, now: NOW }))!;
    // The window is the 24 hours to NOW (20:00), so it opens at 20:00 the day before: the reading
    // from 07:30 yesterday is in force, then the display goes off at 09:30 today.
    expect(u.summary.sessions).toBe(1);
    expect(u.summary.totalMinutes).toBeGreaterThan(90);
  });

  it('returns null for a room that is not this organisation', async () => {
    const w = world();
    expect(
      await roomUsage(w.db, {
        orgId: '99999999-9999-4999-8999-999999999999',
        roomId: ROOM,
        kind: 'av',
        days: 1,
      }),
    ).toBeNull();
  });
});

describe('estate usage and insights', () => {
  it('ranks only rooms with something monitored, and finds under-used rooms', async () => {
    const w = world();
    await w.deviceHistory.createMany({
      data: [h(60, DISPLAY, 'power', 'on'), h(90, DISPLAY, 'power', 'off')],
    });
    const rows = await estateUsage(w.db, { orgId: ORG, kind: 'av', days: 1, now: NOW });
    expect(rows.map((r) => r.roomId)).toEqual([ROOM]);
    const insights = usageInsights(rows, () => 'Boardroom', 1);
    expect(insights.map((i) => i.kind)).toContain('under_used');
  });

  it('flags a room used mostly out of hours', () => {
    const insights = usageInsights(
      [
        {
          roomId: ROOM,
          utilisation: 0.3,
          minutes: 1200,
          sessions: 5,
          averageMinutes: 240,
          afterHoursMinutes: 900,
          inUseNow: false,
        },
      ],
      () => 'Boardroom',
      7,
    );
    expect(insights.map((i) => i.kind)).toEqual(['after_hours']);
  });
});

describe('device charts', () => {
  it('draws only the fields the device has reported, with availability', async () => {
    const w = world();
    await w.deviceHistory.createMany({
      data: [
        h(0, DISPLAY, 'online', 'true'),
        h(60, DISPLAY, 'power', 'on'),
        h(120, DISPLAY, 'volume', '40'),
        h(180, DISPLAY, 'volume', '55'),
        h(360, DISPLAY, 'online', 'false'),
        h(420, DISPLAY, 'online', 'true'),
      ],
    });
    const v = (await deviceHistoryView(w.db, {
      orgId: ORG,
      deviceId: DISPLAY,
      days: 1,
      now: NOW,
    }))!;
    expect(v.series.map((s) => s.field)).toEqual(['online', 'power', 'volume']);
    expect(v.series.find((s) => s.field === 'volume')!.type).toBe('number');
    expect(v.series.find((s) => s.field === 'power')!.type).toBe('state');
    // Up 6h then 5h of 12h window minus the hour down: 660 up, 60 down.
    expect(v.availability).toBeCloseTo(660 / 720, 2);
  });

  it('has nothing for a recorded-only device or another organisation', async () => {
    const w = world();
    expect(await deviceHistoryView(w.db, { orgId: ORG, deviceId: 'lonely', days: 1 })).toBeNull();
    expect(
      await deviceHistoryView(w.db, {
        orgId: '99999999-9999-4999-8999-999999999999',
        deviceId: DISPLAY,
        days: 1,
      }),
    ).toBeNull();
  });
});

describe('roll-up and clean-up', () => {
  it('stores a row per day and kind, and replaces it on a second run', async () => {
    const w = world();
    await w.deviceHistory.createMany({
      data: [h(60, DISPLAY, 'power', 'on'), h(240, DISPLAY, 'power', 'off')],
    });
    const first = await rollupUsage(w.db, NOW);
    expect(first.rooms).toBe(1);
    const rows = w.roomUsageDay.rows.filter((r) => r.kind === 'av');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ roomId: ROOM, minutes: 180, workMinutes: 180, sessions: 1 });
    await rollupUsage(w.db, NOW);
    expect(w.roomUsageDay.rows.filter((r) => r.kind === 'av')).toHaveLength(1);
  });

  it('deletes readings past 90 days and daily figures past 13 months', async () => {
    const w = world();
    const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
    await w.deviceHistory.createMany({
      data: [
        { orgId: ORG, deviceId: DISPLAY, roomId: ROOM, field: 'power', value: 'on', at: day(100) },
        { orgId: ORG, deviceId: DISPLAY, roomId: ROOM, field: 'power', value: 'off', at: day(10) },
      ],
    });
    await w.roomUsageDay.createMany({
      data: [
        {
          roomId: ROOM,
          kind: 'av',
          day: day(500),
          orgId: ORG,
          minutes: 1,
          workMinutes: 1,
          sessions: 1,
          longestMinutes: 1,
          hours: [],
        },
        {
          roomId: ROOM,
          kind: 'av',
          day: day(100),
          orgId: ORG,
          minutes: 1,
          workMinutes: 1,
          sessions: 1,
          longestMinutes: 1,
          hours: [],
        },
      ],
    });
    const r = await pruneUsage(w.db as never, NOW);
    expect(r).toEqual({ readings: 1, days: 1 });
    expect(w.deviceHistory.rows).toHaveLength(1);
    expect(w.roomUsageDay.rows).toHaveLength(1);
  });
});
