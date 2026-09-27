import type { PrismaClient } from '@kestrel/db';
import { zonedDayStart } from './usage-analytics';

// How long a device's own feedback (power, the input it is on, ...) held each value, over a period.
// Built from the `device.feedback` telemetry the gateway already logs on every change (see
// docs/decisions.md TM-18/TM-19), so nothing extra is stored and the reach is the telemetry
// retention window — same shape as usage-analytics.ts. The maths is in plain functions that take
// events; only `deviceFeedbackHistory` touches the database.

export type DeviceFeedbackHistoryDb = Pick<PrismaClient, 'gatewayEvent'>;

/** No more than this many changes are read for one device and field; past it, older ones are dropped. */
export const MAX_FEEDBACK_EVENTS = 3000;

export interface FeedbackChange {
  at: Date;
  value: unknown;
}

export interface ValueDuration {
  /** The value as shown: a boolean becomes "on"/"off", everything else is `String(value)`. */
  value: string;
  minutes: number;
}

const label = (v: unknown): string => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));

/**
 * How long a field held each value between `from` and `to`. `events` is every change to the one
 * field being asked about, in any order; changes before `from` are used only to know the value
 * already in effect when the window opens, and changes at or after `to` are ignored. A window with
 * no change at all before it (nothing known yet) contributes no minutes before the first change.
 */
export function durationsByValue(events: FeedbackChange[], from: Date, to: Date): ValueDuration[] {
  if (to.getTime() <= from.getTime()) return [];
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const totals = new Map<string, number>();
  let current: string | null = null;
  let since = from.getTime();
  const settle = (until: number) => {
    if (current !== null && until > since)
      totals.set(current, (totals.get(current) ?? 0) + (until - since));
  };
  for (const e of sorted) {
    const t = e.at.getTime();
    if (t <= from.getTime()) {
      current = label(e.value);
      continue;
    }
    if (t >= to.getTime()) break;
    settle(t);
    current = label(e.value);
    since = t;
  }
  settle(to.getTime());
  return [...totals.entries()]
    .map(([value, ms]) => ({ value, minutes: Math.round(ms / 60_000) }))
    .sort((a, b) => b.minutes - a.minutes);
}

/** "online" is asked for the same way as a feedback field, but it comes from a different, older pair of events. */
export type HistoryField = string | 'online';

async function fetchFeedbackEvents(
  db: DeviceFeedbackHistoryDb,
  input: { orgId: string; roomId: string; deviceId: string; field: HistoryField; to: Date },
): Promise<{ events: FeedbackChange[]; truncated: boolean }> {
  const rows = await db.gatewayEvent.findMany({
    where: {
      orgId: input.orgId,
      roomId: input.roomId,
      type:
        input.field === 'online' ? { in: ['device.online', 'device.offline'] } : 'device.feedback',
      at: { lt: input.to },
    },
    orderBy: { at: 'asc' },
    take: MAX_FEEDBACK_EVENTS + 1,
    select: { type: true, at: true, data: true },
  });
  const truncated = rows.length > MAX_FEEDBACK_EVENTS;
  const capped = rows.slice(0, MAX_FEEDBACK_EVENTS);
  const events =
    input.field === 'online'
      ? capped
          .map((r) => ({
            at: r.at,
            online: r.type === 'device.online',
            ...(r.data as { deviceId?: string }),
          }))
          .filter((e) => e.deviceId === input.deviceId)
          .map((e) => ({ at: e.at, value: e.online }))
      : capped
          .map((r) => ({
            at: r.at,
            ...(r.data as { deviceId?: string; field?: string; value?: unknown }),
          }))
          .filter((e) => e.deviceId === input.deviceId && e.field === input.field)
          .map((e) => ({ at: e.at, value: e.value }));
  return { events, truncated };
}

/**
 * One device's history for one field, over a period: any `DeviceFeedback` field (power, input, ...),
 * or "online", read from the `device.online`/`device.offline` events every driver has always sent.
 * Either way it is the device's own read-only feedback, control or not.
 */
export async function deviceFeedbackHistory(
  db: DeviceFeedbackHistoryDb,
  input: {
    orgId: string;
    roomId: string;
    deviceId: string;
    field: HistoryField;
    from: Date;
    to: Date;
  },
): Promise<{ durations: ValueDuration[]; truncated: boolean }> {
  const { events, truncated } = await fetchFeedbackEvents(db, input);
  return { durations: durationsByValue(events, input.from, input.to), truncated };
}

// ---- Day-bucketed, for the history chart ---------------------------------------------------------

export interface DayDurations {
  /** The local calendar date this day started on, "YYYY-MM-DD". */
  date: string;
  durations: ValueDuration[];
}

function localYMD(t: number, tz: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/**
 * Splits `durationsByValue` into local calendar days, so a chart's bars line up with the viewer's
 * own days rather than UTC ones. The last day is cut short at `to`; the first is cut short at `from`
 * the same way `durationsByValue` already handles a window that opens mid-change.
 */
export function durationsByDay(
  events: FeedbackChange[],
  from: Date,
  to: Date,
  tz: string,
): DayDurations[] {
  if (to.getTime() <= from.getTime()) return [];
  const days: DayDurations[] = [];
  let { y, m, d } = localYMD(from.getTime(), tz);
  let dayStart = zonedDayStart(tz, y, m, d);
  while (dayStart.getTime() < to.getTime()) {
    const dayEnd = zonedDayStart(tz, y, m, d + 1);
    const windowFrom = new Date(Math.max(dayStart.getTime(), from.getTime()));
    const windowTo = new Date(Math.min(dayEnd.getTime(), to.getTime()));
    days.push({
      date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      durations: durationsByValue(events, windowFrom, windowTo),
    });
    dayStart = dayEnd;
    ({ y, m, d } = localYMD(dayEnd.getTime(), tz));
  }
  return days;
}

/** The same history as `deviceFeedbackHistory`, split into the viewer's local calendar days. */
export async function deviceFeedbackDailyHistory(
  db: DeviceFeedbackHistoryDb,
  input: {
    orgId: string;
    roomId: string;
    deviceId: string;
    field: HistoryField;
    from: Date;
    to: Date;
    tz: string;
  },
): Promise<{ days: DayDurations[]; truncated: boolean }> {
  const { events, truncated } = await fetchFeedbackEvents(db, input);
  return { days: durationsByDay(events, input.from, input.to, input.tz), truncated };
}
