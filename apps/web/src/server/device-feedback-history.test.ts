import { describe, expect, it } from 'vitest';
import {
  MAX_FEEDBACK_EVENTS,
  deviceFeedbackDailyHistory,
  deviceFeedbackHistory,
  durationsByDay,
  durationsByValue,
  type DeviceFeedbackHistoryDb,
  type FeedbackChange,
} from './device-feedback-history';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const ROOM = '33333333-3333-4333-8333-333333333331';
const T0 = new Date('2026-09-27T00:00:00Z');
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

describe('durationsByValue', () => {
  it('splits the window by each change, in minutes', () => {
    const events: FeedbackChange[] = [
      { at: min(10), value: 'HDMI 2' },
      { at: min(40), value: 'Wireless' },
    ];
    // Nothing known before minute 10: the window opens with an unknown value for the first 10 minutes.
    expect(durationsByValue(events, min(0), min(60))).toEqual([
      { value: 'HDMI 2', minutes: 30 },
      { value: 'Wireless', minutes: 20 },
    ]);
  });

  it('carries the value already in effect into the window, from a change before it started', () => {
    const events: FeedbackChange[] = [
      { at: min(-30), value: 'HDMI 1' },
      { at: min(20), value: 'HDMI 2' },
    ];
    expect(durationsByValue(events, min(0), min(60))).toEqual([
      { value: 'HDMI 2', minutes: 40 },
      { value: 'HDMI 1', minutes: 20 },
    ]);
  });

  it('ignores a change at or after the window closes', () => {
    const events: FeedbackChange[] = [
      { at: min(-5), value: 'on' },
      { at: min(60), value: 'off' },
    ];
    expect(durationsByValue(events, min(0), min(60))).toEqual([{ value: 'on', minutes: 60 }]);
  });

  it('turns a boolean into on/off, not "true"/"false"', () => {
    expect(durationsByValue([{ at: min(-1), value: true }], min(0), min(30))).toEqual([
      { value: 'on', minutes: 30 },
    ]);
  });

  it('is empty with no events, or a window that is not open', () => {
    expect(durationsByValue([], min(0), min(30))).toEqual([]);
    expect(durationsByValue([{ at: min(0), value: 'on' }], min(30), min(30))).toEqual([]);
  });

  it('adds up more than one span of the same value', () => {
    const events: FeedbackChange[] = [
      { at: min(-1), value: 'on' },
      { at: min(10), value: 'off' },
      { at: min(20), value: 'on' },
    ];
    expect(durationsByValue(events, min(0), min(30))).toEqual([
      { value: 'on', minutes: 20 },
      { value: 'off', minutes: 10 },
    ]);
  });
});

describe('deviceFeedbackHistory', () => {
  function world(rows: { at: Date; data: object; type?: string }[] = []) {
    const gatewayEvent = table(
      rows.map((r) => ({ orgId: ORG, roomId: ROOM, type: 'device.feedback', ...r })),
    );
    return { db: { gatewayEvent } as unknown as DeviceFeedbackHistoryDb, gatewayEvent };
  }

  it('reads only this device and this field out of the room’s feedback events', async () => {
    const w = world([
      { at: min(-10), data: { deviceId: 'dsp', field: 'input', value: 'HDMI 1' } },
      { at: min(5), data: { deviceId: 'dsp', field: 'input', value: 'HDMI 2' } },
      // A different field on the same device, and the same field on a different device: ignored.
      { at: min(6), data: { deviceId: 'dsp', field: 'muted', value: true } },
      { at: min(7), data: { deviceId: 'display1', field: 'input', value: 'HDMI 3' } },
    ]);
    const { durations } = await deviceFeedbackHistory(w.db, {
      orgId: ORG,
      roomId: ROOM,
      deviceId: 'dsp',
      field: 'input',
      from: min(0),
      to: min(30),
    });
    expect(durations).toEqual([
      { value: 'HDMI 2', minutes: 25 },
      { value: 'HDMI 1', minutes: 5 },
    ]);
  });

  it('says when there were too many events to be sure of the whole window', async () => {
    const rows = Array.from({ length: MAX_FEEDBACK_EVENTS + 5 }, (_, i) => ({
      at: min(i - MAX_FEEDBACK_EVENTS - 5),
      data: { deviceId: 'dsp', field: 'input', value: i % 2 ? 'HDMI 1' : 'HDMI 2' },
    }));
    const w = world(rows);
    const { truncated } = await deviceFeedbackHistory(w.db, {
      orgId: ORG,
      roomId: ROOM,
      deviceId: 'dsp',
      field: 'input',
      from: min(0),
      to: min(30),
    });
    expect(truncated).toBe(true);
  });

  it('reads "online" from device.online/device.offline events, not from device.feedback', async () => {
    const w = world([
      { at: min(-5), type: 'device.online', data: { deviceId: 'dsp', name: 'DSP' } },
      { at: min(10), type: 'device.offline', data: { deviceId: 'dsp', name: 'DSP' } },
      { at: min(20), type: 'device.online', data: { deviceId: 'dsp', name: 'DSP' } },
      // Another device's reachability, and this device's own feedback: neither counts here.
      { at: min(1), type: 'device.offline', data: { deviceId: 'display1', name: 'Display' } },
      {
        at: min(1),
        type: 'device.feedback',
        data: { deviceId: 'dsp', field: 'input', value: 'x' },
      },
    ]);
    const { durations } = await deviceFeedbackHistory(w.db, {
      orgId: ORG,
      roomId: ROOM,
      deviceId: 'dsp',
      field: 'online',
      from: min(0),
      to: min(30),
    });
    expect(durations).toEqual([
      { value: 'on', minutes: 20 },
      { value: 'off', minutes: 10 },
    ]);
  });
});

describe('durationsByDay', () => {
  it('splits a window into local calendar days, in order', () => {
    const events: FeedbackChange[] = [
      { at: new Date('2026-09-27T00:00:00Z'), value: 'on' },
      { at: new Date('2026-09-28T06:00:00Z'), value: 'off' },
    ];
    const days = durationsByDay(
      events,
      new Date('2026-09-27T00:00:00Z'),
      new Date('2026-09-29T00:00:00Z'),
      'UTC',
    );
    expect(days.map((d) => d.date)).toEqual(['2026-09-27', '2026-09-28']);
    expect(days[0]!.durations).toEqual([{ value: 'on', minutes: 1440 }]);
    expect(days[1]!.durations).toEqual([
      { value: 'off', minutes: 1080 },
      { value: 'on', minutes: 360 },
    ]);
  });

  it('uses the viewer’s time zone for day boundaries, not UTC', () => {
    // Tokyo is UTC+9 with no daylight saving: its day starts 9 hours before UTC midnight.
    const events: FeedbackChange[] = [{ at: new Date('2026-09-26T10:00:00Z'), value: 'on' }];
    const days = durationsByDay(
      events,
      new Date('2026-09-26T15:00:00Z'),
      new Date('2026-09-27T15:00:00Z'),
      'Asia/Tokyo',
    );
    expect(days.map((d) => d.date)).toEqual(['2026-09-27']);
    expect(days[0]!.durations).toEqual([{ value: 'on', minutes: 1440 }]);
  });

  it('is empty for a window that is not open', () => {
    expect(durationsByDay([], new Date(0), new Date(0), 'UTC')).toEqual([]);
  });
});

describe('deviceFeedbackDailyHistory', () => {
  function world(rows: { at: Date; data: object; type?: string }[] = []) {
    const gatewayEvent = table(
      rows.map((r) => ({ orgId: ORG, roomId: ROOM, type: 'device.feedback', ...r })),
    );
    return { db: { gatewayEvent } as unknown as DeviceFeedbackHistoryDb };
  }

  it('reads the same events as deviceFeedbackHistory, split by day', async () => {
    const w = world([
      {
        at: new Date('2026-09-27T01:00:00Z'),
        data: { deviceId: 'dsp', field: 'input', value: 'HDMI 1' },
      },
      {
        at: new Date('2026-09-28T01:00:00Z'),
        data: { deviceId: 'dsp', field: 'input', value: 'HDMI 2' },
      },
    ]);
    const { days, truncated } = await deviceFeedbackDailyHistory(w.db, {
      orgId: ORG,
      roomId: ROOM,
      deviceId: 'dsp',
      field: 'input',
      from: new Date('2026-09-27T00:00:00Z'),
      to: new Date('2026-09-29T00:00:00Z'),
      tz: 'UTC',
    });
    expect(truncated).toBe(false);
    expect(days.map((d) => d.date)).toEqual(['2026-09-27', '2026-09-28']);
    expect(days[0]!.durations[0]).toMatchObject({ value: 'HDMI 1' });
    expect(days[1]!.durations[0]).toMatchObject({ value: 'HDMI 2' });
  });
});
