import { describe, expect, it } from 'vitest';
import { summariseBadges, type BadgeRow } from './incident-badges';

const T = (m: number) => new Date(Date.UTC(2026, 9, 2, 10, m));
const row = (id: string, extra: Partial<BadgeRow> = {}): BadgeRow => ({
  id,
  kind: 'device_offline',
  severity: 'warning',
  title: `${id} is offline`,
  roomId: null,
  roomIds: [],
  parentId: null,
  openedAt: T(0),
  acknowledgedAt: null,
  ...extra,
});
const names = new Map([
  ['r1', 'Boardroom'],
  ['r2', 'Lobby'],
]);

describe('incident badges', () => {
  it('is empty when nothing is open', () => {
    expect(summariseBadges([], names)).toEqual({ open: 0, critical: 0, rooms: [], recent: [] });
  });

  it('counts unacknowledged incidents, and the worst severity per room', () => {
    const b = summariseBadges(
      [
        row('a', { roomId: 'r1' }),
        row('b', { roomId: 'r1', severity: 'critical' }),
        row('c', { roomId: 'r2', acknowledgedAt: T(1) }),
      ],
      names,
    );
    expect(b.open).toBe(2);
    expect(b.critical).toBe(1);
    expect(b.rooms).toEqual([{ roomId: 'r1', count: 2, severity: 'critical' }]);
  });

  it('counts a group outage once, but badges the rooms its devices are in', () => {
    const b = summariseBadges(
      [
        row('g', { kind: 'group_outage', severity: 'critical' }),
        row('d1', { roomId: 'r1', parentId: 'g' }),
        row('d2', { roomId: 'r2', parentId: 'g' }),
      ],
      names,
    );
    expect(b.open).toBe(1);
    expect(b.rooms.map((r) => r.roomId).sort()).toEqual(['r1', 'r2']);
    expect(b.recent.map((r) => r.id)).toEqual(['g']);
  });

  it('badges every room a shared device touches, and lists the newest first with room names', () => {
    const b = summariseBadges(
      [
        row('old', { roomId: 'r1', openedAt: T(0) }),
        row('new', { roomId: 'r1', roomIds: ['r2'], openedAt: T(5) }),
      ],
      names,
    );
    expect(b.rooms.find((r) => r.roomId === 'r2')?.count).toBe(1);
    expect(b.recent.map((r) => [r.id, r.roomName])).toEqual([
      ['new', 'Boardroom'],
      ['old', 'Boardroom'],
    ]);
  });
});
