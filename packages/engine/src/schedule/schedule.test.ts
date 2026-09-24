import { describe, expect, it } from 'vitest';
import type { Trigger } from '@kestrel/model';
import { cronMatches, cronProblem, isValidTimezone, localParts, parseCron } from './cron';
import { TriggerScheduler } from './scheduler';

const at = (iso: string) => new Date(iso);
const matches = (expr: string, iso: string, tz = 'UTC') =>
  cronMatches(parseCron(expr), localParts(at(iso), tz));

describe('cron expressions', () => {
  it('matches a fixed time', () => {
    expect(matches('30 8 * * *', '2026-09-24T08:30:00Z')).toBe(true);
    expect(matches('30 8 * * *', '2026-09-24T08:31:00Z')).toBe(false);
    expect(matches('30 8 * * *', '2026-09-24T20:30:00Z')).toBe(false);
  });

  it('supports lists, ranges and steps', () => {
    expect(matches('0,15,30,45 * * * *', '2026-09-24T10:15:00Z')).toBe(true);
    expect(matches('*/20 * * * *', '2026-09-24T10:40:00Z')).toBe(true);
    expect(matches('*/20 * * * *', '2026-09-24T10:41:00Z')).toBe(false);
    expect(matches('0 8-18/2 * * *', '2026-09-24T14:00:00Z')).toBe(true);
    expect(matches('0 8-18/2 * * *', '2026-09-24T15:00:00Z')).toBe(false);
  });

  it('understands weekdays and names, with Sunday as 0 or 7', () => {
    // 24 Sept 2026 is a Thursday.
    expect(matches('0 9 * * 1-5', '2026-09-24T09:00:00Z')).toBe(true);
    expect(matches('0 9 * * MON-FRI', '2026-09-24T09:00:00Z')).toBe(true);
    expect(matches('0 9 * * 0,6', '2026-09-24T09:00:00Z')).toBe(false);
    expect(matches('0 9 * * 0', '2026-09-27T09:00:00Z')).toBe(true);
    expect(matches('0 9 * * 7', '2026-09-27T09:00:00Z')).toBe(true);
    expect(matches('0 9 * SEP *', '2026-09-24T09:00:00Z')).toBe(true);
    expect(matches('0 9 * OCT *', '2026-09-24T09:00:00Z')).toBe(false);
  });

  it('runs on either the day of month or the weekday when both are given', () => {
    // 1st of the month, or any Monday.
    expect(matches('0 9 1 * 1', '2026-10-01T09:00:00Z')).toBe(true); // Thursday the 1st
    expect(matches('0 9 1 * 1', '2026-09-28T09:00:00Z')).toBe(true); // Monday the 28th
    expect(matches('0 9 1 * 1', '2026-09-24T09:00:00Z')).toBe(false);
  });

  it('works in the room’s own time zone, including across midnight and daylight saving', () => {
    // 08:30 in Sydney (UTC+10 in September, UTC+11 after the October switch).
    expect(matches('30 8 * * *', '2026-09-23T22:30:00Z', 'Australia/Sydney')).toBe(true);
    expect(matches('30 8 * * *', '2026-10-24T21:30:00Z', 'Australia/Sydney')).toBe(true);
    expect(matches('30 8 * * *', '2026-10-24T22:30:00Z', 'Australia/Sydney')).toBe(false);
    // The weekday is the local one: 23:30 UTC Sunday is Monday in Sydney.
    expect(matches('30 9 * * 1', '2026-09-27T23:30:00Z', 'Australia/Sydney')).toBe(true);
  });

  it('says what is wrong with a bad expression', () => {
    expect(cronProblem('* * * *')).toContain('5 fields');
    expect(cronProblem('61 * * * *')).toContain('out of range');
    expect(cronProblem('* 24 * * *')).toContain('out of range');
    expect(cronProblem('*/0 * * * *')).toContain('step');
    expect(cronProblem('a * * * *')).toContain('not a valid');
    expect(cronProblem('5-2 * * * *')).toContain('out of range');
    expect(cronProblem('0 9 * * 8')).toContain('out of range');
    expect(cronProblem('0 9 * * *')).toBeNull();
  });

  it('checks time zones', () => {
    expect(isValidTimezone('Australia/Sydney')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });
});

describe('trigger scheduler', () => {
  const schedule = (id: string, cron: string, timezone = 'UTC', enabled = true): Trigger => ({
    id,
    name: id,
    enabled,
    type: 'schedule',
    cron,
    timezone,
    run: { type: 'activity', activityId: 'room_off' },
  });

  function rig(triggers: Trigger[]) {
    let now = at('2026-09-24T08:29:30Z');
    const fired: string[] = [];
    const s = new TriggerScheduler({ triggers }, { fire: (t) => fired.push(t.id), now: () => now });
    return { s, fired, set: (iso: string) => void (now = at(iso)) };
  }

  it('fires when the minute arrives, and only once however often it looks', () => {
    const r = rig([schedule('open', '30 8 * * *')]);
    r.s.tick();
    expect(r.fired).toEqual([]);
    r.set('2026-09-24T08:30:00Z');
    r.s.tick();
    r.set('2026-09-24T08:30:29Z');
    r.s.tick();
    r.s.tick();
    expect(r.fired).toEqual(['open']);
    r.set('2026-09-24T08:31:00Z');
    r.s.tick();
    expect(r.fired).toEqual(['open']);
    // And again the next day.
    r.set('2026-09-25T08:30:10Z');
    r.s.tick();
    expect(r.fired).toEqual(['open', 'open']);
  });

  it('does not fire again for the minute it was created in, such as after a redeploy', () => {
    const r = rig([schedule('open', '30 8 * * *')]);
    r.set('2026-09-24T08:30:20Z');
    const late = new TriggerScheduler(
      { triggers: [schedule('open', '30 8 * * *')] },
      { fire: (t) => r.fired.push(t.id), now: () => at('2026-09-24T08:30:20Z') },
    );
    late.tick();
    expect(r.fired).toEqual([]);
  });

  it('runs several schedules independently, and skips disabled or broken ones', () => {
    const r = rig([
      schedule('a', '30 8 * * *'),
      schedule('b', '*/1 * * * *'),
      schedule('off', '30 8 * * *', 'UTC', false),
      schedule('bad', 'nonsense'),
      schedule('tz', '30 8 * * *', 'Mars/Olympus'),
    ]);
    expect(r.s.count).toBe(2);
    r.set('2026-09-24T08:30:00Z');
    r.s.tick();
    expect(r.fired.sort()).toEqual(['a', 'b']);
  });

  it('keeps going if one schedule’s action throws', () => {
    const fired: string[] = [];
    let now = at('2026-09-24T08:29:59Z');
    const s = new TriggerScheduler(
      { triggers: [schedule('boom', '* * * * *'), schedule('ok', '* * * * *')] },
      {
        now: () => now,
        fire: (t) => {
          if (t.id === 'boom') throw new Error('boom');
          fired.push(t.id);
        },
      },
    );
    now = at('2026-09-24T08:30:00Z');
    s.tick();
    expect(fired).toEqual(['ok']);
  });

  it('is idle with nothing scheduled', () => {
    const s = new TriggerScheduler({ triggers: [] }, { fire: () => undefined });
    s.start();
    expect(s.count).toBe(0);
    s.stop();
  });
});
