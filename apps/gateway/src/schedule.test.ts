import { describe, expect, it } from 'vitest';
import type { Meeting } from '@kestrel/model';
import { ScheduleStore, STALE_MS } from './schedule';

const ROOM = '33333333-3333-4333-8333-333333333331';
const OTHER = '33333333-3333-4333-8333-333333333332';
const meeting = (id: string): Meeting => ({
  id,
  title: id,
  start: '2026-09-28T09:00:00.000Z',
  end: '2026-09-28T10:00:00.000Z',
  private: false,
});

describe('room bookings held by the gateway', () => {
  it('knows nothing about a room the cloud has not described', () => {
    expect(new ScheduleStore().get(ROOM)).toBeNull();
  });

  it('keeps what the cloud sent, and tells listeners only when it changes', () => {
    const s = new ScheduleStore();
    const heard: string[] = [];
    s.onChange((id) => heard.push(id));
    s.apply([{ roomId: ROOM, meetings: [meeting('a')] }], 1000);
    s.apply([{ roomId: ROOM, meetings: [meeting('a')] }], 2000);
    expect(heard).toEqual([ROOM]);
    expect(s.get(ROOM, 3000)?.map((m) => m.id)).toEqual(['a']);
    s.apply([{ roomId: ROOM, meetings: [meeting('a'), meeting('b')] }], 4000);
    expect(heard).toEqual([ROOM, ROOM]);
  });

  it('tells "no meetings today" from "not known"', () => {
    const s = new ScheduleStore();
    s.apply([{ roomId: ROOM, meetings: [] }], 1000);
    expect(s.get(ROOM, 1000)).toEqual([]);
    expect(s.get(OTHER, 1000)).toBeNull();
  });

  it('keeps a room the cloud stops mentioning, until its bookings go stale', () => {
    const s = new ScheduleStore();
    const heard: string[] = [];
    s.onChange((id) => heard.push(id));
    s.apply([{ roomId: ROOM, meetings: [meeting('a')] }], 0);
    s.apply([], STALE_MS - 1);
    expect(s.get(ROOM, STALE_MS - 1)).not.toBeNull();
    s.expire(STALE_MS + 1);
    expect(s.get(ROOM, STALE_MS + 1)).toBeNull();
    // Panels are told to hide them.
    expect(heard).toEqual([ROOM, ROOM]);
  });

  it('never returns bookings that have gone stale, even if nothing has swept them yet', () => {
    const s = new ScheduleStore();
    s.apply([{ roomId: ROOM, meetings: [meeting('a')] }], 0);
    expect(s.get(ROOM, STALE_MS + 1)).toBeNull();
  });
});
