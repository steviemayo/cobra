import { describe, expect, it } from 'vitest';
import { scheduleView, type Meeting } from './schedule';

const at = (hhmm: string) => `2026-09-28T${hhmm}:00.000Z`;
const meeting = (id: string, start: string, end: string, over: Partial<Meeting> = {}): Meeting => ({
  id,
  title: `Meeting ${id}`,
  organiser: 'Sam Lee',
  start: at(start),
  end: at(end),
  private: false,
  ...over,
});
const now = (hhmm: string) => new Date(at(hhmm));

describe('scheduleView', () => {
  it('says nothing when there are no meetings', () => {
    expect(scheduleView([], now('09:00'))).toEqual({
      current: null,
      next: null,
      availableAt: null,
    });
  });

  it('shows the meeting that is on, with when the room is next free', () => {
    const v = scheduleView([meeting('a', '09:00', '10:00')], now('09:30'));
    expect(v.current?.id).toBe('a');
    expect(v.availableAt).toEqual(now('10:00'));
    expect(v.next).toBeNull();
  });

  it('shows the next meeting while the room is free', () => {
    const v = scheduleView(
      [meeting('a', '09:00', '10:00'), meeting('b', '13:00', '14:00')],
      now('11:00'),
    );
    expect(v.current).toBeNull();
    expect(v.next?.id).toBe('b');
    expect(v.availableAt).toBeNull();
  });

  it('counts meetings that run straight into each other as one', () => {
    const v = scheduleView(
      [
        meeting('a', '09:00', '10:00'),
        meeting('b', '10:00', '11:00'),
        meeting('c', '11:30', '12:00'),
      ],
      now('09:10'),
    );
    expect(v.availableAt).toEqual(now('11:00'));
    // The next meeting is the first one that has not started, even though it follows straight on.
    expect(v.next?.id).toBe('b');
  });

  it('follows overlapping meetings to the last end', () => {
    const v = scheduleView(
      [meeting('a', '09:00', '11:00'), meeting('b', '10:00', '10:30')],
      now('10:15'),
    );
    expect(v.current?.id).toBe('a');
    expect(v.availableAt).toEqual(now('11:00'));
  });

  it('is free the moment a meeting ends and busy the moment one starts', () => {
    const list = [meeting('a', '09:00', '10:00'), meeting('b', '10:30', '11:00')];
    expect(scheduleView(list, now('10:00')).current).toBeNull();
    expect(scheduleView(list, now('10:30')).current?.id).toBe('b');
  });

  it('ignores meetings with a broken time', () => {
    const bad = meeting('x', '09:00', '10:00', { start: 'nonsense' });
    expect(scheduleView([bad], now('09:30')).current).toBeNull();
    expect(scheduleView([meeting('y', '10:00', '09:00')], now('09:30')).current).toBeNull();
  });
});
