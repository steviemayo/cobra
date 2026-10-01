import type { Prisma, PrismaClient } from '@kestrel/db';
import {
  DEFAULT_USAGE_RULES,
  DEFAULT_WORKING_HOURS,
  UsageRuleSchema,
  checkUsageRule,
  computeSessions,
  availableWorkMinutes,
  countWorkingDays,
  inUseNow,
  ruleInputs,
  safeTimeZone,
  summariseUsage,
  utilisation,
  type UsageKind,
  type UsageRule,
  type UsageSummary,
  type WorkingHours,
  type ReadingEvent,
} from '@kestrel/model';

// Room and device usage (docs/pivot-monitoring.md, "Analytics"). Sessions are worked out from stored
// reading changes each time, so changing a room's rule changes its past. Functions take the database
// as a parameter so they can be tested without one.
export type UsageDb = Pick<
  PrismaClient,
  | 'device'
  | 'deviceHistory'
  | 'usageDefinition'
  | 'usageSettings'
  | 'roomUsageDay'
  | 'room'
  | 'site'
>;

const DAY_MS = 86_400_000;
/** Raw reading history is kept this long. */
export const HISTORY_DAYS = 90;
/** A day's totals are kept this long after the raw readings are gone. */
export const ROLLUP_MONTHS = 13;

export const DEFAULT_HOLD_OFF_SECONDS = 180;
export const DEFAULT_MIN_ON_SECONDS = 60;

// ---- Settings and definitions --------------------------------------------------------------------

export async function loadWorkingHours(db: UsageDb, orgId: string): Promise<WorkingHours> {
  const row = await db.usageSettings.findFirst({ where: { orgId } });
  if (!row) return DEFAULT_WORKING_HOURS;
  return { days: row.workDays, start: row.workStart, end: row.workEnd };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function saveWorkingHours(
  db: UsageDb,
  orgId: string,
  input: WorkingHours,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!HHMM.test(input.start) || !HHMM.test(input.end))
    return { ok: false, message: 'Times must look like 08:00' };
  if (input.start >= input.end)
    return { ok: false, message: 'Working hours must end after they start' };
  const days = [...new Set(input.days)]
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    .sort();
  if (days.length === 0) return { ok: false, message: 'Pick at least one working day' };
  const data = { workDays: days, workStart: input.start, workEnd: input.end };
  const row = await db.usageSettings.findFirst({ where: { orgId } });
  if (row) await db.usageSettings.update({ where: { orgId }, data });
  else await db.usageSettings.create({ data: { orgId, ...data } });
  return { ok: true };
}

export interface Definition {
  rule: UsageRule;
  holdOffSeconds: number;
  minOnSeconds: number;
  /** Where it came from: this room's own, the organisation's default, or Kestrel's. */
  source: 'room' | 'org' | 'default';
}

function parseRule(v: unknown): UsageRule | null {
  const r = UsageRuleSchema.safeParse(v);
  return r.success && !checkUsageRule(r.data) ? r.data : null;
}

/** The rule for a room: its own, else the organisation's, else the usual one. */
export async function getDefinition(
  db: UsageDb,
  orgId: string,
  roomId: string,
  kind: UsageKind,
): Promise<Definition> {
  for (const [scope, rid] of [
    ['room', roomId],
    ['org', null],
  ] as const) {
    const row = await db.usageDefinition.findFirst({ where: { orgId, roomId: rid, kind } });
    const rule = row ? parseRule(row.rule) : null;
    if (row && rule)
      return {
        rule,
        holdOffSeconds: row.holdOffSeconds,
        minOnSeconds: row.minOnSeconds,
        source: scope,
      };
  }
  return {
    rule: DEFAULT_USAGE_RULES[kind],
    holdOffSeconds: DEFAULT_HOLD_OFF_SECONDS,
    minOnSeconds: DEFAULT_MIN_ON_SECONDS,
    source: 'default',
  };
}

export async function saveDefinition(
  db: UsageDb,
  input: {
    orgId: string;
    roomId: string | null;
    kind: UsageKind;
    rule: unknown;
    holdOffSeconds: number;
    minOnSeconds: number;
    userId: string | null;
  },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = UsageRuleSchema.safeParse(input.rule);
  if (!parsed.success) return { ok: false, message: 'That rule is not valid' };
  const problem = checkUsageRule(parsed.data);
  if (problem) return { ok: false, message: problem };
  if (input.roomId) {
    const room = await db.room.findFirst({ where: { id: input.roomId, orgId: input.orgId } });
    if (!room) return { ok: false, message: 'No such room' };
  }
  const data = {
    rule: parsed.data as unknown as Prisma.InputJsonValue,
    holdOffSeconds: Math.max(0, Math.min(3600, Math.round(input.holdOffSeconds))),
    minOnSeconds: Math.max(0, Math.min(3600, Math.round(input.minOnSeconds))),
    updatedBy: input.userId,
  };
  const where = { orgId: input.orgId, roomId: input.roomId, kind: input.kind };
  const row = await db.usageDefinition.findFirst({ where });
  if (row) await db.usageDefinition.update({ where: { id: row.id }, data });
  else await db.usageDefinition.create({ data: { ...where, ...data } });
  return { ok: true };
}

/** Removes a room's own rule (it falls back to the organisation's) or the organisation's (back to Kestrel's). */
export async function resetDefinition(
  db: UsageDb,
  orgId: string,
  roomId: string | null,
  kind: UsageKind,
) {
  await db.usageDefinition.deleteMany({ where: { orgId, roomId, kind } });
}

// ---- Loading a room's readings -------------------------------------------------------------------

/** The readings in force at `from` plus every change up to `to`, for the fields and devices a rule uses. */
async function loadEvents(
  db: UsageDb,
  orgId: string,
  devices: { id: string }[],
  fields: string[],
  from: Date,
  to: Date,
): Promise<ReadingEvent[]> {
  if (devices.length === 0 || fields.length === 0) return [];
  const ids = devices.map((d) => d.id);
  const events: ReadingEvent[] = [];
  // What each device last said before the window opened.
  for (const deviceId of ids)
    for (const field of fields) {
      const last = await db.deviceHistory.findFirst({
        where: { orgId, deviceId, field, at: { lt: from } },
        orderBy: { at: 'desc' },
      });
      if (last) events.push({ at: last.at.getTime(), deviceId, field, value: last.value });
    }
  const within = await db.deviceHistory.findMany({
    where: { orgId, deviceId: { in: ids }, field: { in: fields }, at: { gte: from, lt: to } },
    orderBy: { at: 'asc' },
  });
  for (const r of within)
    events.push({ at: r.at.getTime(), deviceId: r.deviceId, field: r.field, value: r.value });
  return events;
}

export interface RoomUsage {
  kind: UsageKind;
  source: Definition['source'];
  from: Date;
  to: Date;
  timeZone: string;
  working: WorkingHours;
  workingDays: number;
  /** Working minutes in the window: what the room could have been in use for. */
  availableMinutes: number;
  summary: UsageSummary;
  /** Share of available working time in use, 0 to 1, or null when no working time was in the window. */
  utilisation: number | null;
  /** Whether it is in use right now by this rule, from each device's latest reading. Null when nothing is monitored. */
  inUseNow: boolean | null;
  monitoredDevices: number;
}

function latestLookup(devices: { id: string; feedback: unknown; online: boolean | null }[]) {
  const map = new Map<string, string>();
  for (const d of devices) {
    if (d.online !== null) map.set(`${d.id}|online`, String(d.online));
    const fb = (d.feedback ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(fb))
      if (v !== undefined && v !== null) map.set(`${d.id}|${k}`, String(v));
  }
  return (deviceId: string, field: string) => map.get(`${deviceId}|${field}`);
}

/** One room's usage over the last `days` days by its rule. */
export async function roomUsage(
  db: UsageDb,
  input: { orgId: string; roomId: string; kind: UsageKind; days: number; now?: Date },
): Promise<RoomUsage | null> {
  const room = await db.room.findFirst({ where: { id: input.roomId, orgId: input.orgId } });
  if (!room) return null;
  const site = await db.site.findFirst({ where: { id: room.siteId, orgId: input.orgId } });
  const timeZone = safeTimeZone(site?.timezone);
  const now = input.now ?? new Date();
  const days = Math.max(1, Math.min(HISTORY_DAYS, Math.round(input.days)));
  const from = new Date(now.getTime() - days * DAY_MS);
  const [working, def, devices] = await Promise.all([
    loadWorkingHours(db, input.orgId),
    getDefinition(db, input.orgId, room.id, input.kind),
    db.device.findMany({ where: { orgId: input.orgId, roomId: room.id } }),
  ]);
  const active = devices.filter((d) => d.kind === 'active');
  const ruleDevices = devices.map((d) => ({ id: d.id, category: d.category }));
  const inputs = ruleInputs(def.rule);
  const events = await loadEvents(db, input.orgId, active, [...inputs.fields], from, now);
  const intervals = computeSessions({
    events,
    devices: ruleDevices,
    rule: def.rule,
    from: from.getTime(),
    to: now.getTime(),
    holdOffMs: def.holdOffSeconds * 1000,
    minOnMs: def.minOnSeconds * 1000,
  });
  const summary = summariseUsage(intervals, timeZone, working);
  const workingDays = countWorkingDays(from.getTime(), now.getTime(), timeZone, working);
  const availableMinutes = availableWorkMinutes(from.getTime(), now.getTime(), timeZone, working);
  return {
    kind: input.kind,
    source: def.source,
    from,
    to: now,
    timeZone,
    working,
    workingDays,
    availableMinutes,
    summary,
    utilisation: utilisation(summary, availableMinutes),
    inUseNow: active.length ? inUseNow(def.rule, ruleDevices, latestLookup(active)) : null,
    monitoredDevices: active.length,
  };
}

// ---- Across the estate ---------------------------------------------------------------------------

export interface RoomUsageRow {
  roomId: string;
  utilisation: number | null;
  minutes: number;
  sessions: number;
  averageMinutes: number;
  afterHoursMinutes: number;
  inUseNow: boolean | null;
}

/** Every room with something monitored, for ranking and insights. */
export async function estateUsage(
  db: UsageDb,
  input: { orgId: string; kind: UsageKind; days: number; now?: Date },
): Promise<RoomUsageRow[]> {
  const rooms = await db.room.findMany({ where: { orgId: input.orgId } });
  const devices = await db.device.findMany({ where: { orgId: input.orgId, kind: 'active' } });
  const monitored = new Set(devices.map((d) => d.roomId).filter((r): r is string => !!r));
  const out: RoomUsageRow[] = [];
  for (const r of rooms) {
    if (!monitored.has(r.id)) continue;
    const u = await roomUsage(db, { ...input, roomId: r.id });
    if (!u) continue;
    out.push({
      roomId: r.id,
      utilisation: u.utilisation,
      minutes: u.summary.totalMinutes,
      sessions: u.summary.sessions,
      averageMinutes: u.summary.averageMinutes,
      afterHoursMinutes: u.summary.afterHoursMinutes,
      inUseNow: u.inUseNow,
    });
  }
  return out;
}

export interface UsageInsight {
  kind: 'under_used' | 'after_hours' | 'always_on';
  roomId: string;
  title: string;
  detail: string;
}

/** Plain rule-based findings from the room rows. No model needed. */
export function usageInsights(
  rows: RoomUsageRow[],
  name: (roomId: string) => string,
  days: number,
): UsageInsight[] {
  const out: UsageInsight[] = [];
  for (const r of rows) {
    if (r.utilisation !== null && r.utilisation < 0.1)
      out.push({
        kind: 'under_used',
        roomId: r.roomId,
        title: `${name(r.roomId)} is barely used`,
        detail: `In use ${Math.round(r.utilisation * 100)}% of working time over ${days} days.`,
      });
    if (r.afterHoursMinutes >= 60 * 5 && r.minutes > 0 && r.afterHoursMinutes / r.minutes > 0.5)
      out.push({
        kind: 'after_hours',
        roomId: r.roomId,
        title: `${name(r.roomId)} is mostly in use out of hours`,
        detail: `${Math.round(r.afterHoursMinutes / 60)} hours outside working time, more than half of its use. Is equipment being left on?`,
      });
    if (r.minutes >= days * 20 * 60)
      out.push({
        kind: 'always_on',
        roomId: r.roomId,
        title: `${name(r.roomId)} looks like it is always in use`,
        detail:
          'It was in use for about 20 hours a day or more. Check the rule, or the equipment is not turning off.',
      });
  }
  return out;
}

// ---- Device charts -------------------------------------------------------------------------------

export interface SeriesPoint {
  at: number;
  value: string;
}
export interface DeviceSeries {
  field: string;
  /** number: drawn as a line. state: drawn as bars of time in each state. */
  type: 'number' | 'state';
  /** The value in force at the start of the window, then every change. */
  points: SeriesPoint[];
  /** For state series: minutes spent in each value. */
  minutesByValue: Record<string, number>;
}
export interface DeviceHistoryView {
  from: number;
  to: number;
  series: DeviceSeries[];
  /** Share of the window the device was answering, 0 to 1, from its online readings. Null with no readings. */
  availability: number | null;
}

/**
 * Charts for one device: only fields it has actually reported. What a driver can report decides
 * what appears, so nothing is drawn for a point the device does not have.
 */
export async function deviceHistoryView(
  db: UsageDb,
  input: { orgId: string; deviceId: string; days: number; now?: Date },
): Promise<DeviceHistoryView | null> {
  const device = await db.device.findFirst({ where: { id: input.deviceId, orgId: input.orgId } });
  if (!device || device.kind !== 'active') return null;
  const now = input.now ?? new Date();
  const days = Math.max(1, Math.min(HISTORY_DAYS, Math.round(input.days)));
  const from = new Date(now.getTime() - days * DAY_MS);
  const within = await db.deviceHistory.findMany({
    where: { orgId: input.orgId, deviceId: device.id, at: { gte: from, lt: now } },
    orderBy: { at: 'asc' },
  });
  const fields = [...new Set(within.map((r) => r.field))];
  const series: DeviceSeries[] = [];
  let availability: number | null = null;
  for (const field of fields) {
    const before = await db.deviceHistory.findFirst({
      where: { orgId: input.orgId, deviceId: device.id, field, at: { lt: from } },
      orderBy: { at: 'desc' },
    });
    const rows = within.filter((r) => r.field === field);
    const points: SeriesPoint[] = [
      ...(before ? [{ at: from.getTime(), value: before.value }] : []),
      ...rows.map((r) => ({ at: r.at.getTime(), value: r.value })),
    ];
    const minutesByValue: Record<string, number> = {};
    points.forEach((p, i) => {
      const end = points[i + 1]?.at ?? now.getTime();
      minutesByValue[p.value] = (minutesByValue[p.value] ?? 0) + (end - p.at) / 60_000;
    });
    for (const k of Object.keys(minutesByValue)) minutesByValue[k] = Math.round(minutesByValue[k]!);
    if (field === 'online') {
      const up = minutesByValue.true ?? 0;
      const down = minutesByValue.false ?? 0;
      availability = up + down > 0 ? up / (up + down) : null;
    }
    const numeric = points.every(
      (p) =>
        p.value !== '' && !Number.isNaN(Number(p.value)) && !['true', 'false'].includes(p.value),
    );
    series.push({ field, type: numeric ? 'number' : 'state', points, minutesByValue });
  }
  // Availability first; the rest in the order the device reported them.
  series.sort((a, b) => (a.field === 'online' ? -1 : b.field === 'online' ? 1 : 0));
  return { from: from.getTime(), to: now.getTime(), series, availability };
}

// ---- Daily roll-up and clean-up ------------------------------------------------------------------

/**
 * Stores the last two days of each monitored room's usage as one row per day and kind, so the
 * figures outlive the raw readings (13 months against 90 days). Safe to run as often as you like.
 */
export async function rollupUsage(
  db: UsageDb,
  now = new Date(),
): Promise<{ rooms: number; rows: number }> {
  const devices = await db.device.findMany({ where: { kind: 'active' } });
  const roomIds = [...new Set(devices.map((d) => d.roomId).filter((r): r is string => !!r))];
  let rows = 0;
  for (const roomId of roomIds) {
    const room = await db.room.findFirst({ where: { id: roomId } });
    if (!room) continue;
    for (const kind of ['av', 'occupied'] as UsageKind[]) {
      const u = await roomUsage(db, { orgId: room.orgId, roomId, kind, days: 2, now });
      if (!u) continue;
      for (const d of u.summary.days) {
        const day = new Date(`${d.day}T00:00:00.000Z`);
        await db.roomUsageDay.deleteMany({ where: { roomId, kind, day } });
        await db.roomUsageDay.create({
          data: {
            roomId,
            kind,
            day,
            orgId: room.orgId,
            minutes: d.minutes,
            workMinutes: d.workMinutes,
            sessions: d.sessions,
            longestMinutes: d.longestMinutes,
            hours: d.hours,
          },
        });
        rows++;
      }
    }
  }
  return { rooms: roomIds.length, rows };
}

/** Deletes raw readings older than 90 days and daily figures older than 13 months. */
export async function pruneUsage(
  db: Pick<PrismaClient, 'deviceHistory' | 'roomUsageDay'>,
  now = new Date(),
) {
  const rawCutoff = new Date(now.getTime() - HISTORY_DAYS * DAY_MS);
  const dayCutoff = new Date(now);
  dayCutoff.setUTCMonth(dayCutoff.getUTCMonth() - ROLLUP_MONTHS);
  const raw = await db.deviceHistory.deleteMany({ where: { at: { lt: rawCutoff } } });
  const daily = await db.roomUsageDay.deleteMany({ where: { day: { lt: dayCutoff } } });
  return { readings: raw.count, days: daily.count };
}
