import type { PrismaClient } from '@kestrel/db';

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
  return { durations: durationsByValue(events, input.from, input.to), truncated };
}
