import type { PrismaClient } from '@kestrel/db';
import { StoredMeetings, type Meeting } from '@kestrel/model';
import { clock, validZone, weekDays, weekEnd, weekStart } from '../lib/week';
import { meetingsBetween, openProfile, type Deps } from './calendar';
import { windowOccurrences, type WindowRow } from './maintenance';
import { FRESH_MS, STORE_AHEAD_MS, roomCalendar, storeSchedule } from './room-schedule';

// The room calendar page (Monday to Sunday, times blocked out) and the checks that use the same
// bookings when maintenance is planned. Read only: no calendar is ever written to.
export type RoomCalendarDb = Pick<
  PrismaClient,
  'room' | 'site' | 'device' | 'calendarConnection' | 'roomSchedule' | 'maintenanceWindow'
>;

const DEFAULT_ZONE = 'Australia/Sydney';
/** A week holds at most this many bookings on screen. */
const WEEK_LIMIT = 300;

export interface WeekMeeting extends Meeting {
  /** Private meetings are drawn as "Busy". */
  busy: boolean;
}

export interface WeekView {
  timezone: string;
  /** Monday 00:00 in the site's zone, as an instant. */
  weekStart: string;
  days: { start: string; end: string }[];
  meetings: WeekMeeting[];
  /** Maintenance windows (this room's, its site's or the whole organisation's) in the week. */
  windows: { id: string; name: string; scope: string; start: string; end: string }[];
  /** live: read from the calendar just now. copy: Kestrel's saved copy, because it couldn't be reached. none: no calendar. */
  source: 'live' | 'copy' | 'none';
  /** Why the calendar couldn't be read, when source is copy or none and a calendar is set. */
  problem: string | null;
  configured: boolean;
}

/** Hides what a private meeting must not reveal. */
export const asBusy = (m: Meeting): WeekMeeting => ({
  ...m,
  title: m.private ? '' : m.title,
  organiser: m.private ? undefined : m.organiser,
  busy: m.private,
});

const realDeps = (): Deps => ({ fetch, secretsKey: process.env.KESTREL_SECRETS_KEY });

async function siteZone(db: Pick<PrismaClient, 'site'>, siteId: string): Promise<string> {
  const tz = (await db.site.findFirst({ where: { id: siteId } }))?.timezone;
  return tz && validZone(tz) ? tz : DEFAULT_ZONE;
}

/** The week a room's calendar shows. `at` is any moment in the wanted week (default: now). */
export async function roomWeek(
  db: RoomCalendarDb,
  room: {
    id: string;
    orgId: string;
    siteId: string;
    calendarConnectionId: string | null;
    calendarResource: string | null;
  },
  at: Date,
  deps: Deps = realDeps(),
  now = new Date(),
): Promise<WeekView> {
  const timezone = await siteZone(db, room.siteId);
  const start = weekStart(at, timezone);
  const end = weekEnd(start, timezone);
  const days = weekDays(start, timezone).map((d) => ({
    start: d.start.toISOString(),
    end: d.end.toISOString(),
  }));

  const windows = (
    (await db.maintenanceWindow.findMany({ where: { orgId: room.orgId } })) as WindowRow[]
  )
    .filter(
      (w) =>
        w.scope === 'org' ||
        (w.scope === 'site' && w.scopeId === room.siteId) ||
        (w.scope === 'room' && w.scopeId === room.id),
    )
    .flatMap((w) =>
      windowOccurrences(w, start, end).map((o) => ({
        id: w.id,
        name: w.name,
        scope: w.scope,
        start: o.start.toISOString(),
        end: o.end.toISOString(),
      })),
    );

  const cal = roomCalendar(room);
  const base = { timezone, weekStart: start.toISOString(), days, windows };
  if (!cal) return { ...base, meetings: [], source: 'none', problem: null, configured: false };

  const inRange = (m: Meeting) =>
    Date.parse(m.end) > start.getTime() && Date.parse(m.start) < end.getTime();
  const fromCopy = async () => {
    const row = await db.roomSchedule.findFirst({ where: { roomId: room.id, orgId: room.orgId } });
    const parsed = row ? StoredMeetings.safeParse(row.meetings) : null;
    return parsed?.success ? parsed.data.filter(inRange) : [];
  };

  try {
    const profile = await db.calendarConnection.findFirst({
      where: { id: cal.connectionId, orgId: room.orgId },
    });
    if (!profile || !deps.secretsKey) throw new Error('The calendar profile is not available');
    const creds = openProfile(profile, deps.secretsKey);
    if (!creds) throw new Error('The calendar profile could not be read');
    const live = await meetingsBetween(
      creds,
      cal.resource,
      start,
      end,
      deps,
      now.getTime(),
      WEEK_LIMIT,
    );
    return {
      ...base,
      meetings: live.sort((a, b) => a.start.localeCompare(b.start)).map(asBusy),
      source: 'live',
      problem: null,
      configured: true,
    };
  } catch (e) {
    const meetings = (await fromCopy()).map(asBusy);
    return {
      ...base,
      meetings,
      source: meetings.length ? 'copy' : 'none',
      problem: e instanceof Error ? e.message : 'The calendar could not be read',
      configured: true,
    };
  }
}

/** Reads a room's calendar now and saves the copy, so a newly chosen calendar works straight away. */
export async function refreshRoomNow(
  db: Pick<PrismaClient, 'calendarConnection' | 'roomSchedule'>,
  room: { id: string; orgId: string },
  connectionId: string,
  resource: string,
  deps: Deps = realDeps(),
  now = new Date(),
): Promise<Meeting[]> {
  const profile = await db.calendarConnection.findFirst({
    where: { id: connectionId, orgId: room.orgId },
  });
  if (!profile || !deps.secretsKey) throw new Error('The calendar profile is not available');
  const creds = openProfile(profile, deps.secretsKey);
  if (!creds) throw new Error('The calendar profile could not be read');
  const exists = !!(await db.roomSchedule.findFirst({ where: { roomId: room.id } }));
  return storeSchedule(db, room, creds, resource, now, deps, exists);
}

// ---- Maintenance planning ------------------------------------------------------------------------

export interface Clash {
  roomId: string;
  roomName: string;
  meeting: WeekMeeting;
}

export interface ClashReport {
  clashes: Clash[];
  /** Rooms the window covers, and how many of them have a calendar Kestrel can check. */
  rooms: number;
  checked: number;
  /** Bookings are only known this many days ahead. */
  horizonDays: number;
  /** When one room is covered and the time clashes: the next times that suit, as ISO strings. */
  suggestions: string[];
}

/** Meetings in the covered rooms that overlap the planned time (and, for repeats, the next 14 days). */
export async function maintenanceClashes(
  db: RoomCalendarDb,
  orgId: string,
  plan: {
    scope: string;
    scopeId: string | null;
    startsAt: Date;
    endsAt: Date;
    repeat?: string;
    repeatUntil?: Date | null;
  },
  now = new Date(),
): Promise<ClashReport> {
  const all = await db.room.findMany({ where: { orgId } });
  let rooms = all;
  if (plan.scope === 'room') rooms = all.filter((r) => r.id === plan.scopeId);
  else if (plan.scope === 'site') rooms = all.filter((r) => r.siteId === plan.scopeId);
  else if (plan.scope === 'device') {
    const d = plan.scopeId
      ? await db.device.findFirst({ where: { id: plan.scopeId, orgId } })
      : null;
    rooms = d?.roomId ? all.filter((r) => r.id === d.roomId) : [];
  }
  const horizon = new Date(now.getTime() + STORE_AHEAD_MS);
  const times = windowOccurrences(
    {
      id: '',
      orgId,
      name: '',
      scope: plan.scope,
      scopeId: plan.scopeId,
      startsAt: plan.startsAt,
      endsAt: plan.endsAt,
      repeat: plan.repeat ?? 'none',
      repeatUntil: plan.repeatUntil ?? null,
    },
    new Date(Math.min(plan.startsAt.getTime(), now.getTime())),
    horizon,
  );
  const rows = await db.roomSchedule.findMany({
    where: { orgId, roomId: { in: rooms.map((r) => r.id) } },
  });
  const copies = new Map(rows.map((r) => [r.roomId, r]));
  const clashes: Clash[] = [];
  let checked = 0;
  for (const room of rooms) {
    const row = copies.get(room.id);
    const parsed = row ? StoredMeetings.safeParse(row.meetings) : null;
    if (!row || !parsed?.success || now.getTime() - row.fetchedAt.getTime() > FRESH_MS * 4)
      continue;
    checked++;
    for (const m of parsed.data) {
      const s = Date.parse(m.start);
      const e = Date.parse(m.end);
      if (times.some((t) => s < t.end.getTime() && e > t.start.getTime()))
        clashes.push({ roomId: room.id, roomName: room.name, meeting: asBusy(m) });
    }
  }
  clashes.sort((a, b) => a.meeting.start.localeCompare(b.meeting.start));
  let suggestions: string[] = [];
  const only = rooms.length === 1 ? rooms[0]! : null;
  if (only && clashes.length) {
    const zone = await siteZone(db, only.siteId);
    const duration = plan.endsAt.getTime() - plan.startsAt.getTime();
    const kept = StoredMeetings.safeParse(copies.get(only.id)?.meetings);
    suggestions = freeSlots(kept.success ? kept.data : [], duration, now, zone).map((d) =>
      d.toISOString(),
    );
  }
  return {
    clashes,
    rooms: rooms.length,
    checked,
    horizonDays: STORE_AHEAD_MS / 86_400_000,
    suggestions,
  };
}

/** The earliest times that fit, working hours only. */
export const WORK_START_HOUR = 6;
export const WORK_END_HOUR = 20;

/**
 * Up to `count` start times, at least two hours apart, where a job of `durationMs` clashes with
 * none of `meetings`. Looks at the next 14 days, from 06:00 to 20:00 in the zone, every 30 minutes.
 */
export function freeSlots(
  meetings: readonly { start: string; end: string }[],
  durationMs: number,
  from: Date,
  timeZone: string,
  count = 3,
): Date[] {
  const busy = meetings.map((m) => [Date.parse(m.start), Date.parse(m.end)] as const);
  const out: Date[] = [];
  const stepMs = 30 * 60_000;
  const last = from.getTime() + STORE_AHEAD_MS;
  // Begin at the next half hour.
  for (let t = Math.ceil(from.getTime() / stepMs) * stepMs; t < last; t += stepMs) {
    if (out.length >= count) break;
    const end = t + durationMs;
    const a = clock(new Date(t), timeZone);
    const b = clock(new Date(end), timeZone);
    const startMin = a.h * 60 + a.mi;
    const endMin = b.h * 60 + b.mi;
    const sameDay = end - t < 24 * 3_600_000 && endMin > startMin;
    if (!sameDay || startMin < WORK_START_HOUR * 60 || endMin > WORK_END_HOUR * 60) continue;
    if (busy.some(([s, e]) => s < end && e > t)) continue;
    if (out.length && t - out[out.length - 1]!.getTime() < 2 * 3_600_000) continue;
    out.push(new Date(t));
  }
  return out;
}
