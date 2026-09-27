import type { PrismaClient } from '@kestrel/db';
import { RoomModel } from '@kestrel/model';

// Usage reports: how much each room is used, when, for what, and whether anyone is in it while it
// is on. Worked out from the telemetry the gateways already send (room on/off, someone in the room,
// activity started), so nothing extra is stored and the reach is the telemetry retention window. A
// room is "in use" while its status is starting or on. The maths is in plain functions that take
// events; only `loadUsageReport` touches the database, and takes it as a parameter for tests.
export type UsageDb = Pick<PrismaClient, 'room' | 'roomDraft' | 'gatewayEvent'>;

export interface UsageEvent {
  roomId: string;
  type: string;
  at: Date;
  data: unknown;
}

export interface UsageOptions {
  from: Date;
  to: Date;
  /** IANA time zone the business hours, days and hours of the week are read in. */
  tz: string;
  /** Business hours, on Monday to Friday: from this hour up to (not including) this hour. */
  businessStartHour: number;
  businessEndHour: number;
}

export interface ActivityCount {
  activityId: string;
  name: string;
  count: number;
}

export interface RoomUsage {
  roomId: string;
  name: string;
  siteId: string;
  /** False when no occupancy sensor has ever reported for this room in the window. */
  hasOccupancy: boolean;
  /** Minutes with data: from the room's first report (or the start of the range) to the end. */
  coveredMinutes: number;
  inUseMinutes: number;
  businessInUseMinutes: number;
  /** Share of business hours the room was in use, 0 to 1. Null with no data. */
  utilisation: number | null;
  sessions: number;
  avgSessionMinutes: number | null;
  occupiedMinutes: number;
  /** On with nobody in it. Only when the room has an occupancy sensor. */
  inUseEmptyMinutes: number;
  /** Someone in it while it was off. Only when the room has an occupancy sensor. */
  occupiedIdleMinutes: number;
  lastUsedAt: string | null;
  activities: ActivityCount[];
}

export interface Insight {
  kind: 'in_use_empty' | 'occupied_idle' | 'underused' | 'busy';
  roomId: string;
  text: string;
}

export interface UsageReport {
  from: string;
  to: string;
  tz: string;
  businessStartHour: number;
  businessEndHour: number;
  rooms: RoomUsage[];
  /** Minutes in use, by weekday (Monday first) and hour of the day, all rooms together. */
  heatmap: number[][];
  /** Minutes in use by local date, all rooms together, oldest first, every day of the range. */
  daily: { date: string; inUseMinutes: number }[];
  activities: ActivityCount[];
  insights: Insight[];
  /** More events than could be read, so the totals are low. */
  truncated: boolean;
}

// ---- Time in a zone ------------------------------------------------------------------------------

const SLICE_MS = 15 * 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
const offsets = new Map<string, number>();

/** Whether a time zone name is one the runtime knows. */
export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function offsetMs(tz: string, t: number): number {
  const hour = Math.floor(t / 3_600_000);
  const key = `${tz}|${hour}`;
  const hit = offsets.get(key);
  if (hit !== undefined) return hit;
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(tz, f);
  }
  const parts = f.formatToParts(new Date(hour * 3_600_000));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  const off = local - hour * 3_600_000;
  if (offsets.size > 20_000) offsets.clear();
  offsets.set(key, off);
  return off;
}

/** The moment a local calendar day begins in a time zone, as a real time. */
export function zonedDayStart(tz: string, year: number, month: number, day = 1): Date {
  const guess = Date.UTC(year, month - 1, day);
  // Read the offset at the guess, then again at the answer, so a day that starts across a clock change is right.
  const first = guess - offsetMs(tz, guess);
  return new Date(guess - offsetMs(tz, first));
}

interface LocalTime {
  date: string;
  /** Monday is 0. */
  weekday: number;
  hour: number;
}

function localTime(t: number, tz: string): LocalTime {
  const d = new Date(t + offsetMs(tz, t));
  return {
    date: d.toISOString().slice(0, 10),
    weekday: (d.getUTCDay() + 6) % 7,
    hour: d.getUTCHours(),
  };
}

/** Calls back once per quarter hour (or part of one) of the interval, with its local time. */
function forEachSlice(startMs: number, endMs: number, tz: string, cb: (at: LocalTime, minutes: number) => void) {
  let t = startMs;
  while (t < endMs) {
    const next = Math.min(endMs, (Math.floor(t / SLICE_MS) + 1) * SLICE_MS);
    cb(localTime(t, tz), (next - t) / 60_000);
    t = next;
  }
}

// ---- Intervals -----------------------------------------------------------------------------------

type Interval = [number, number];

/** When the predicate held, from a room's ordered events, cut to [from, to]. */
function holds(events: UsageEvent[], types: string[], on: (e: UsageEvent) => boolean | undefined, from: number, to: number): Interval[] {
  const out: Interval[] = [];
  let since: number | null = null;
  for (const e of events) {
    if (!types.includes(e.type)) continue;
    const state = on(e);
    if (state === undefined) continue;
    const at = e.at.getTime();
    if (state && since === null) since = at;
    else if (!state && since !== null) {
      push(out, since, at, from, to);
      since = null;
    }
  }
  if (since !== null) push(out, since, to, from, to);
  return out;
}

function push(out: Interval[], start: number, end: number, from: number, to: number) {
  const s = Math.max(start, from);
  const e = Math.min(end, to);
  if (e > s) out.push([s, e]);
}

const length = (list: Interval[]) => list.reduce((n, [s, e]) => n + (e - s), 0) / 60_000;

/** The time both lists cover. Each list is ordered and does not overlap itself. */
function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i]![0], b[j]![0]);
    const e = Math.min(a[i]![1], b[j]![1]);
    if (e > s) out.push([s, e]);
    if (a[i]![1] < b[j]![1]) i++;
    else j++;
  }
  return out;
}

const isBusiness = (t: LocalTime, o: UsageOptions) =>
  t.weekday < 5 && t.hour >= o.businessStartHour && t.hour < o.businessEndHour;

function businessMinutes(list: Interval[], o: UsageOptions): number {
  let n = 0;
  for (const [s, e] of list)
    forEachSlice(s, e, o.tz, (t, m) => {
      if (isBusiness(t, o)) n += m;
    });
  return n;
}

// ---- One room ------------------------------------------------------------------------------------

const IN_USE = new Set(['starting', 'on']);
const dataOf = (e: UsageEvent) => (e.data && typeof e.data === 'object' ? (e.data as Record<string, unknown>) : {});

export function analyseRoom(
  room: { roomId: string; name: string; siteId: string },
  events: UsageEvent[],
  o: UsageOptions,
  activityNames: Map<string, string>,
  add?: { heatmap: number[][]; daily: Map<string, number> },
): RoomUsage {
  const from = o.from.getTime();
  const to = o.to.getTime();
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const status = holds(sorted, ['room.status'], (e) => {
    const s = dataOf(e).status;
    return typeof s === 'string' ? IN_USE.has(s) : undefined;
  }, from, to);
  const occupancyEvents = sorted.filter((e) => e.type === 'room.occupancy');
  const hasOccupancy = occupancyEvents.length > 0;
  const occupied = holds(sorted, ['room.occupancy'], (e) => {
    const v = dataOf(e).occupied;
    return typeof v === 'boolean' ? v : undefined;
  }, from, to);
  const both = intersect(status, occupied);

  // Only count from when the room first reported, so a new room is not "unused" before it existed.
  const first = sorted.length ? sorted[0]!.at.getTime() : to;
  const coveredFrom = Math.max(from, first);
  const covered: Interval[] = coveredFrom < to ? [[coveredFrom, to]] : [];
  const businessWindow = businessMinutes(covered, o);
  const businessInUse = businessMinutes(status, o);
  const inUse = length(status);

  if (add)
    for (const [s, e] of status)
      forEachSlice(s, e, o.tz, (t, m) => {
        add.heatmap[t.weekday]![t.hour]! += m;
        add.daily.set(t.date, (add.daily.get(t.date) ?? 0) + m);
      });

  const counts = new Map<string, number>();
  for (const e of sorted) {
    if (e.type !== 'activity.started') continue;
    const at = e.at.getTime();
    const id = dataOf(e).activityId;
    if (at < from || at > to || typeof id !== 'string') continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const activities = [...counts]
    .map(([activityId, count]) => ({ activityId, name: activityNames.get(activityId) ?? activityId, count }))
    .sort((a, b) => b.count - a.count);

  const lastEnd = status.length ? status[status.length - 1]![1] : null;
  return {
    roomId: room.roomId,
    name: room.name,
    siteId: room.siteId,
    hasOccupancy,
    coveredMinutes: length(covered),
    inUseMinutes: inUse,
    businessInUseMinutes: businessInUse,
    utilisation: businessWindow > 0 ? Math.min(1, businessInUse / businessWindow) : null,
    sessions: status.length,
    avgSessionMinutes: status.length ? inUse / status.length : null,
    occupiedMinutes: hasOccupancy ? length(occupied) : 0,
    inUseEmptyMinutes: hasOccupancy ? inUse - length(both) : 0,
    occupiedIdleMinutes: hasOccupancy ? length(occupied) - length(both) : 0,
    lastUsedAt: lastEnd ? new Date(lastEnd).toISOString() : null,
    activities,
  };
}

// ---- All rooms -----------------------------------------------------------------------------------

const hours = (m: number) => (m >= 90 ? `${Math.round(m / 60)} h` : `${Math.round(m)} min`);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const MIN_SIGNAL_MINUTES = 60;
const MIN_DAYS_FOR_UNDERUSED = 3;

export function insightsFor(rooms: RoomUsage[]): Insight[] {
  const out: Insight[] = [];
  for (const r of rooms) {
    if (r.hasOccupancy && r.inUseMinutes >= MIN_SIGNAL_MINUTES && r.inUseEmptyMinutes / r.inUseMinutes >= 0.4)
      out.push({
        kind: 'in_use_empty',
        roomId: r.roomId,
        text: `${r.name} was on with nobody in it for ${hours(r.inUseEmptyMinutes)} (${pct(r.inUseEmptyMinutes / r.inUseMinutes)} of the time it was on).`,
      });
    if (r.hasOccupancy && r.occupiedMinutes >= MIN_SIGNAL_MINUTES && r.occupiedIdleMinutes / r.occupiedMinutes >= 0.5)
      out.push({
        kind: 'occupied_idle',
        roomId: r.roomId,
        text: `People were in ${r.name} for ${hours(r.occupiedIdleMinutes)} without using it (${pct(r.occupiedIdleMinutes / r.occupiedMinutes)} of the time it was occupied).`,
      });
    if (r.utilisation !== null && r.coveredMinutes >= MIN_DAYS_FOR_UNDERUSED * 1440) {
      if (r.utilisation < 0.1)
        out.push({ kind: 'underused', roomId: r.roomId, text: `${r.name} was in use for only ${pct(r.utilisation)} of business hours.` });
      else if (r.utilisation > 0.7)
        out.push({ kind: 'busy', roomId: r.roomId, text: `${r.name} is heavily used: ${pct(r.utilisation)} of business hours.` });
    }
  }
  const rank = { in_use_empty: 0, occupied_idle: 1, underused: 2, busy: 3 } as const;
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]).slice(0, 8);
}

/** Every local date from `from` to `to`, so a quiet day still shows as zero. */
function eachDate(from: Date, to: Date, tz: string): string[] {
  const dates: string[] = [];
  const add = (t: number) => {
    const d = localTime(t, tz).date;
    if (dates[dates.length - 1] !== d) dates.push(d);
  };
  const last = Math.max(from.getTime(), to.getTime() - 1);
  for (let t = from.getTime(); t <= last; t += 86_400_000) add(t);
  add(last);
  return dates;
}

export function buildReport(
  rooms: { roomId: string; name: string; siteId: string }[],
  events: UsageEvent[],
  activityNames: Map<string, Map<string, string>>,
  o: UsageOptions,
  truncated = false,
): UsageReport {
  const byRoom = new Map<string, UsageEvent[]>();
  for (const e of events) (byRoom.get(e.roomId) ?? byRoom.set(e.roomId, []).get(e.roomId)!).push(e);
  const heatmap = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const daily = new Map<string, number>();
  const usage = rooms
    .map((r) => analyseRoom(r, byRoom.get(r.roomId) ?? [], o, activityNames.get(r.roomId) ?? new Map(), { heatmap, daily }))
    .sort((a, b) => (b.utilisation ?? -1) - (a.utilisation ?? -1) || a.name.localeCompare(b.name));

  const totals = new Map<string, ActivityCount>();
  for (const r of usage)
    for (const a of r.activities) {
      // The same activity id (for example "present") means the same thing in every room, so it adds up.
      const t = totals.get(a.name) ?? { activityId: a.activityId, name: a.name, count: 0 };
      t.count += a.count;
      totals.set(a.name, t);
    }
  return {
    from: o.from.toISOString(),
    to: o.to.toISOString(),
    tz: o.tz,
    businessStartHour: o.businessStartHour,
    businessEndHour: o.businessEndHour,
    rooms: usage,
    heatmap: heatmap.map((row) => row.map((m) => Math.round(m))),
    daily: eachDate(o.from, o.to, o.tz).map((date) => ({ date, inUseMinutes: Math.round(daily.get(date) ?? 0) })),
    activities: [...totals.values()].sort((a, b) => b.count - a.count),
    insights: insightsFor(usage),
    truncated,
  };
}

// ---- From the database ---------------------------------------------------------------------------

export const MAX_USAGE_EVENTS = 250_000;
const TYPES = ['room.status', 'room.occupancy', 'activity.started'];

export async function loadUsageReport(
  db: UsageDb,
  orgId: string,
  o: UsageOptions,
  scope: Record<string, unknown> = {},
): Promise<UsageReport> {
  const rooms = await db.room.findMany({
    where: { orgId, ...scope },
    select: { id: true, name: true, siteId: true },
    orderBy: { name: 'asc' },
  });
  const ids = rooms.map((r) => r.id);
  if (ids.length === 0) return buildReport([], [], new Map(), o);

  const [inRange, seeds, drafts] = await Promise.all([
    db.gatewayEvent.findMany({
      where: { orgId, roomId: { in: ids }, type: { in: TYPES }, at: { gte: o.from, lte: o.to } },
      orderBy: { at: 'asc' },
      take: MAX_USAGE_EVENTS + 1,
      select: { roomId: true, type: true, at: true, data: true },
    }),
    // What each room was doing when the range began: the last status and occupancy report before it.
    db.gatewayEvent.findMany({
      where: { orgId, roomId: { in: ids }, type: { in: ['room.status', 'room.occupancy'] }, at: { lt: o.from } },
      distinct: ['roomId', 'type'],
      orderBy: { at: 'desc' },
      select: { roomId: true, type: true, at: true, data: true },
    }),
    db.roomDraft.findMany({ where: { orgId, roomId: { in: ids } }, select: { roomId: true, model: true } }),
  ]);
  const truncated = inRange.length > MAX_USAGE_EVENTS;
  const events = [...seeds, ...inRange.slice(0, MAX_USAGE_EVENTS)].flatMap((e) =>
    e.roomId ? [{ roomId: e.roomId, type: e.type, at: e.at, data: e.data }] : [],
  );
  const names = new Map<string, Map<string, string>>();
  for (const d of drafts) {
    const model = RoomModel.safeParse(d.model);
    if (model.success) names.set(d.roomId, new Map(model.data.activities.map((a) => [a.id, a.name])));
  }
  return buildReport(
    rooms.map((r) => ({ roomId: r.id, name: r.name, siteId: r.siteId })),
    events,
    names,
    o,
    truncated,
  );
}
