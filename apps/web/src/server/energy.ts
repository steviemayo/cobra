import { DEFAULT_WORKING_HOURS, safeTimeZone, summariseUsage } from '@kestrel/model';
import { loadWorkingHours, HISTORY_DAYS, type UsageDb } from './usage-service';

// An estimate of the energy displays and projectors use when nobody is working, from the power
// state they report. It is a planning number, not a meter: Kestrel does not know a display's real
// draw, so each category has a typical wattage. It shows where equipment is left on, and roughly
// what that costs, so a customer can decide whether a power-off schedule is worth setting up.

/** Typical on-state draw in watts, by device category. Only these categories are counted. */
export const TYPICAL_WATTS: Record<string, number> = {
  display: 150,
  video_destination: 150,
  projector: 300,
};

/** kg of CO2 per kWh. An approximate Australian grid average; it differs by state and year. */
export const CO2_KG_PER_KWH = 0.7;

/** Power states in which the equipment is drawing power. "off" is treated as standby draw, which is small. */
const DRAWING = new Set(['on', 'warming', 'cooling']);

const DAY_MS = 86_400_000;

export interface Interval {
  start: number;
  end: number;
}

/** The stretches of time a device was drawing power, from its power readings. `before` is the reading in force at `from`. */
export function drawingIntervals(
  readings: { at: number; value: string }[],
  before: string | null,
  from: number,
  to: number,
): Interval[] {
  const points = [
    ...(before !== null ? [{ at: from, value: before }] : []),
    ...[...readings].sort((a, b) => a.at - b.at),
  ];
  const out: Interval[] = [];
  let start: number | null = null;
  for (const p of points) {
    const on = DRAWING.has(p.value);
    if (on && start === null) start = Math.max(p.at, from);
    if (!on && start !== null) {
      if (p.at > start) out.push({ start, end: Math.min(p.at, to) });
      start = null;
    }
  }
  if (start !== null && to > start) out.push({ start, end: to });
  return out;
}

export interface RoomEnergy {
  roomId: string;
  devices: number;
  /** Minutes of drawing power, summed over the room's displays. */
  onMinutes: number;
  /** Of those, minutes outside working hours (nights, weekends). */
  afterHoursMinutes: number;
  /** All the energy the room's displays drew while on, working hours included. */
  onKwh: number;
  afterHoursKwh: number;
  afterHoursCo2Kg: number;
}

export interface EstateEnergy {
  days: number;
  rows: RoomEnergy[];
  totals: {
    devices: number;
    onKwh: number;
    afterHoursKwh: number;
    afterHoursCo2Kg: number;
    /** After-hours energy scaled to a year from this window. */
    afterHoursKwhPerYear: number;
  };
  assumptions: { wattsByCategory: Record<string, number>; co2KgPerKwh: number };
}

const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

/** After-hours energy of every monitored display and projector, grouped by room. */
export async function estateEnergy(
  db: UsageDb,
  input: { orgId: string; days: number; now?: Date },
): Promise<EstateEnergy> {
  const now = input.now ?? new Date();
  const days = Math.max(1, Math.min(HISTORY_DAYS, Math.round(input.days)));
  const from = new Date(now.getTime() - days * DAY_MS);
  const [working, rooms, sites, devices] = await Promise.all([
    loadWorkingHours(db, input.orgId).catch(() => DEFAULT_WORKING_HOURS),
    db.room.findMany({ where: { orgId: input.orgId } }),
    db.site.findMany({ where: { orgId: input.orgId } }),
    db.device.findMany({ where: { orgId: input.orgId, kind: 'active' } }),
  ]);
  const zoneOf = new Map(
    rooms.map((r) => [r.id, safeTimeZone(sites.find((s) => s.id === r.siteId)?.timezone)]),
  );
  const counted = devices.filter((d) => d.roomId && TYPICAL_WATTS[d.category] !== undefined);
  const history = counted.length
    ? await db.deviceHistory.findMany({
        where: {
          orgId: input.orgId,
          deviceId: { in: counted.map((d) => d.id) },
          field: 'power',
          at: { gte: from, lt: now },
        },
        orderBy: { at: 'asc' },
      })
    : [];

  const byRoom = new Map<string, RoomEnergy>();
  for (const d of counted) {
    const own = history.filter((h) => h.deviceId === d.id);
    const last = await db.deviceHistory.findFirst({
      where: { orgId: input.orgId, deviceId: d.id, field: 'power', at: { lt: from } },
      orderBy: { at: 'desc' },
    });
    // A device with no power reading at all says nothing, so it adds nothing.
    if (own.length === 0 && !last) continue;
    const intervals = drawingIntervals(
      own.map((h) => ({ at: h.at.getTime(), value: h.value })),
      last?.value ?? null,
      from.getTime(),
      now.getTime(),
    );
    const summary = summariseUsage(intervals, zoneOf.get(d.roomId!) ?? 'UTC', working);
    const kw = TYPICAL_WATTS[d.category]! / 1000;
    const row = byRoom.get(d.roomId!) ?? {
      roomId: d.roomId!,
      devices: 0,
      onMinutes: 0,
      afterHoursMinutes: 0,
      onKwh: 0,
      afterHoursKwh: 0,
      afterHoursCo2Kg: 0,
    };
    row.devices += 1;
    row.onMinutes += summary.totalMinutes;
    row.afterHoursMinutes += summary.afterHoursMinutes;
    row.onKwh += (summary.totalMinutes / 60) * kw;
    row.afterHoursKwh += (summary.afterHoursMinutes / 60) * kw;
    byRoom.set(d.roomId!, row);
  }

  const rowsOut = [...byRoom.values()]
    .map((r) => ({
      ...r,
      onKwh: round(r.onKwh),
      afterHoursKwh: round(r.afterHoursKwh),
      afterHoursCo2Kg: round(r.afterHoursKwh * CO2_KG_PER_KWH),
    }))
    .sort((a, b) => b.afterHoursKwh - a.afterHoursKwh);
  const afterHoursKwh = [...byRoom.values()].reduce((s, r) => s + r.afterHoursKwh, 0);
  const onKwh = [...byRoom.values()].reduce((s, r) => s + r.onKwh, 0);
  return {
    days,
    rows: rowsOut,
    totals: {
      devices: rowsOut.reduce((s, r) => s + r.devices, 0),
      onKwh: round(onKwh),
      afterHoursKwh: round(afterHoursKwh),
      afterHoursCo2Kg: round(afterHoursKwh * CO2_KG_PER_KWH),
      afterHoursKwhPerYear: Math.round((afterHoursKwh * 365) / days),
    },
    assumptions: { wattsByCategory: TYPICAL_WATTS, co2KgPerKwh: CO2_KG_PER_KWH },
  };
}
