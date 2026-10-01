import { describe, expect, it } from 'vitest';
import { keepBookings } from './room-schedule';
import { roomTimeline, type TimelineDb } from './room-timeline';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222221';
const ROOM = '33333333-3333-4333-8333-333333333331';
const GW = '44444444-4444-4444-8444-444444444441';
const D_DISPLAY = '55555555-5555-4555-8555-555555555551';
const D_UC = '55555555-5555-4555-8555-555555555552';
const D_QUIET = '55555555-5555-4555-8555-555555555553';
const NOW = new Date('2026-10-02T05:00:00Z'); // Fri 2 Oct, 15:00 in Sydney (AEST)

interface Booking {
  id: string;
  roomId: string;
  orgId: string;
  eventId: string;
  title: string;
  organiser: string | null;
  private: boolean;
  startsAt: Date;
  endsAt: Date;
  seenAt: Date;
}

/** Just enough of `roomBooking` for keepBookings. */
function bookings(rows: Booking[] = []) {
  return {
    rows,
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { roomId_eventId_startsAt: { roomId: string; eventId: string; startsAt: Date } };
      create: Booking;
      update: Partial<Booking>;
    }) => {
      const k = where.roomId_eventId_startsAt;
      const hit = rows.find(
        (r) =>
          r.roomId === k.roomId &&
          r.eventId === k.eventId &&
          r.startsAt.getTime() === k.startsAt.getTime(),
      );
      if (hit) Object.assign(hit, update);
      else rows.push({ ...create, id: `b${rows.length}` });
    },
    findMany: async ({ where }: { where: { roomId: string; startsAt: { gt: Date } } }) =>
      rows.filter((r) => r.roomId === where.roomId && r.startsAt > where.startsAt.gt),
    deleteMany: async ({
      where,
    }: {
      where: { id?: { in: string[] }; roomId?: string; endsAt?: { lt: Date } };
    }) => {
      const drop = rows.filter(
        (r) =>
          (where.id ? where.id.in.includes(r.id) : true) &&
          (where.endsAt ? r.endsAt < where.endsAt.lt : true) &&
          (where.id || where.endsAt),
      );
      for (const r of drop) rows.splice(rows.indexOf(r), 1);
    },
  };
}

const meeting = (id: string, start: string, end: string, extra = {}) => ({
  id,
  title: `Meeting ${id}`,
  organiser: 'Sam',
  start,
  end,
  private: false,
  ...extra,
});

describe('keeping booking history', () => {
  const room = { id: ROOM, orgId: ORG };

  it('keeps a booking after it has passed, and removes a future one that was cancelled', async () => {
    const t = bookings();
    const db = { roomBooking: t } as never;
    await keepBookings(
      db,
      room,
      [
        meeting('past', '2026-10-02T03:00:00Z', '2026-10-02T04:00:00Z'),
        meeting('later', '2026-10-02T07:00:00Z', '2026-10-02T08:00:00Z'),
      ],
      new Date('2026-10-02T02:00:00Z'),
    );
    expect(t.rows.map((r) => r.eventId).sort()).toEqual(['later', 'past']);

    // Later the calendar no longer returns the one that has been and gone (it is before `now`), and
    // the cancelled future one is gone from the calendar too.
    await keepBookings(db, room, [], NOW);
    expect(t.rows.map((r) => r.eventId)).toEqual(['past']);
  });

  it('updates a moved booking in place and stores private meetings without a title', async () => {
    const t = bookings();
    const db = { roomBooking: t } as never;
    await keepBookings(
      db,
      room,
      [meeting('x', '2026-10-02T07:00:00Z', '2026-10-02T08:00:00Z', { private: true })],
      NOW,
    );
    expect(t.rows[0]).toMatchObject({ title: '', organiser: null, private: true });
    await keepBookings(
      db,
      room,
      [meeting('x', '2026-10-02T07:00:00Z', '2026-10-02T09:00:00Z', { private: true })],
      NOW,
    );
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]!.endsAt.toISOString()).toBe('2026-10-02T09:00:00.000Z');
  });

  it('drops bookings older than 90 days and never throws', async () => {
    const t = bookings([
      {
        id: 'old',
        roomId: ROOM,
        orgId: ORG,
        eventId: 'old',
        title: 'Old',
        organiser: null,
        private: false,
        startsAt: new Date('2026-06-01T00:00:00Z'),
        endsAt: new Date('2026-06-01T01:00:00Z'),
        seenAt: NOW,
      },
    ]);
    await keepBookings({ roomBooking: t } as never, room, [], NOW);
    expect(t.rows).toHaveLength(0);
    // A database without the table (or one that fails) is not an error.
    await expect(keepBookings({} as never, room, [], NOW)).resolves.toBeUndefined();
    await expect(
      keepBookings(
        { roomBooking: { upsert: async () => Promise.reject(new Error('no table')) } } as never,
        room,
        [meeting('a', '2026-10-02T07:00:00Z', '2026-10-02T08:00:00Z')],
        NOW,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('the room timeline', () => {
  const roomRow = {
    id: ROOM,
    orgId: ORG,
    siteId: SITE,
    gatewayId: GW,
    calendarConnectionId: null,
    calendarResource: null,
  };
  const incident = (
    id: string,
    subject: string,
    start: string,
    end: string | null,
    extra = {},
  ) => ({
    id,
    orgId: ORG,
    roomId: ROOM,
    roomIds: [] as string[],
    gatewayId: GW,
    kind: 'device_offline',
    subject,
    severity: 'warning',
    title: `${subject} offline`,
    openedAt: new Date(start),
    resolvedAt: end ? new Date(end) : null,
    acknowledgedAt: null,
    ...extra,
  });
  const device = (id: string, name: string, extra = {}) => ({
    id,
    orgId: ORG,
    roomId: ROOM,
    name,
    category: 'display',
    kind: 'active',
    online: true,
    gatewayId: GW,
    ...extra,
  });

  function fakeDb(incidents: ReturnType<typeof incident>[], kept: Booking[]): TimelineDb {
    return {
      site: { findFirst: async () => ({ id: SITE, timezone: 'Australia/Sydney' }) },
      maintenanceWindow: { findMany: async () => [] },
      calendarConnection: { findFirst: async () => null },
      device: {
        findMany: async () => [
          device(D_QUIET, 'Zebra display'),
          device(D_UC, 'UC-Engine', { category: 'conference' }),
          device(D_DISPLAY, 'Display'),
          device('ignored', 'Passive box', { kind: 'passive', online: null }),
        ],
      },
      incident: { findMany: async () => incidents },
      roomBooking: { findMany: async () => kept },
    } as never;
  }
  const kept: Booking = {
    id: 'b1',
    roomId: ROOM,
    orgId: ORG,
    eventId: 'm1',
    title: 'Board meeting',
    organiser: 'Sam',
    private: false,
    startsAt: new Date('2026-10-02T03:00:00Z'), // 13:00 Sydney
    endsAt: new Date('2026-10-02T04:00:00Z'),
    seenAt: NOW,
  };

  it('puts lanes with faults first, earliest first, then quiet devices; one lane per device', async () => {
    const db = fakeDb(
      [
        incident('i1', `device:${D_UC}`, '2026-10-02T03:10:00Z', '2026-10-02T03:20:00Z'),
        incident('i2', `device:${D_DISPLAY}`, '2026-10-02T01:00:00Z', '2026-10-02T01:05:00Z'),
        incident('i3', `device:${D_UC}`, '2026-10-02T04:30:00Z', null),
        incident('i4', ROOM, '2026-10-02T02:00:00Z', '2026-10-02T02:10:00Z', {
          kind: 'room_fault',
        }),
        incident('i5', GW, '2026-10-02T00:30:00Z', '2026-10-02T00:40:00Z', {
          kind: 'gateway_offline',
          roomId: null,
        }),
      ],
      [kept],
    );
    const t = await roomTimeline(db, roomRow, NOW, undefined, NOW);
    expect(t.lanes.map((l) => l.name)).toEqual([
      'Gateway and network',
      'Display',
      'Room',
      'UC-Engine',
      'Zebra display',
    ]);
    expect(t.lanes.find((l) => l.name === 'UC-Engine')!.incidents.map((i) => i.id)).toEqual([
      'i1',
      'i3',
    ]);
    // The device nobody can see the state of has no lane.
    expect(t.lanes.some((l) => l.name === 'Passive box')).toBe(false);
    expect(t.meetings.map((m) => m.title)).toEqual(['Board meeting']);
    expect(t.source).toBe('history');
    expect(t.configured).toBe(false);
  });

  it('frames the day in the site zone and leaves an open fault open', async () => {
    const db = fakeDb([incident('i3', `device:${D_UC}`, '2026-10-02T04:30:00Z', null)], []);
    const t = await roomTimeline(db, roomRow, NOW, undefined, NOW);
    // Friday 2 Oct 00:00 AEST is Thursday 14:00 UTC.
    expect(t.dayStart).toBe('2026-10-01T14:00:00.000Z');
    expect(t.dayEnd).toBe('2026-10-02T14:00:00.000Z');
    expect(t.lanes[0]!.incidents[0]!.end).toBeNull();
    expect(t.source).toBe('none');
  });
});
