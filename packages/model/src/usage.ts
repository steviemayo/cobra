import { z } from 'zod';

// Room usage (docs/pivot-monitoring.md, "Analytics"). A room is "in use" when a rule over its
// devices' readings says so. The rule is a small boolean tree the customer can edit; sessions are
// worked out by replaying stored reading changes through it, so changing a rule recomputes the past.
// Everything here is pure.

export const USAGE_KINDS = ['av', 'occupied'] as const;
export const UsageKind = z.enum(USAGE_KINDS);
export type UsageKind = z.infer<typeof UsageKind>;
export const USAGE_KIND_LABEL: Record<UsageKind, string> = {
  av: 'AV in use',
  occupied: 'Occupied',
};

export const CONDITION_COMPARES = ['eq', 'neq', 'gt', 'lt', 'present'] as const;
export type ConditionCompare = (typeof CONDITION_COMPARES)[number];

export interface UsageCondition {
  op: 'cond';
  /** One device, or (when absent) any device of `category` in the room. */
  deviceId?: string;
  category?: string;
  /** A feedback field (power, input, muted, volume, occupied, recording, streamConnected, ...) or "online". */
  field: string;
  cmp: ConditionCompare;
  value?: string | number | boolean;
}
export type UsageRule =
  UsageCondition | { op: 'and' | 'or'; rules: UsageRule[] } | { op: 'not'; rule: UsageRule };

const Condition: z.ZodType<UsageCondition> = z.object({
  op: z.literal('cond'),
  deviceId: z.string().max(64).optional(),
  category: z.string().max(40).optional(),
  field: z.string().min(1).max(40),
  cmp: z.enum(CONDITION_COMPARES),
  value: z.union([z.string().max(100), z.number(), z.boolean()]).optional(),
});

const MAX_DEPTH = 6;
const MAX_NODES = 50;

export const UsageRuleSchema: z.ZodType<UsageRule> = z.lazy(() =>
  z.union([
    Condition,
    z.object({ op: z.enum(['and', 'or']), rules: z.array(UsageRuleSchema).min(1).max(20) }),
    z.object({ op: z.literal('not'), rule: UsageRuleSchema }),
  ]),
);

/** A rule is refused when it is too deep or too big to be a human's rule, or a condition names nothing. */
export function checkUsageRule(rule: UsageRule): string | null {
  let nodes = 0;
  const walk = (r: UsageRule, depth: number): string | null => {
    if (++nodes > MAX_NODES) return 'This rule is too large';
    if (depth > MAX_DEPTH) return 'This rule is nested too deeply';
    if (r.op === 'cond') {
      if (!r.deviceId && !r.category) return 'Every condition needs a device or a kind of device';
      if (r.cmp !== 'present' && r.value === undefined)
        return 'Every condition needs a value to compare with';
      return null;
    }
    if (r.op === 'not') return walk(r.rule, depth + 1);
    for (const c of r.rules) {
      const err = walk(c, depth + 1);
      if (err) return err;
    }
    return null;
  };
  return walk(rule, 0);
}

export interface RuleDevice {
  id: string;
  category: string;
}
/** The latest known value of a field on a device, as text, or undefined when never reported. */
export type ReadingLookup = (deviceId: string, field: string) => string | undefined;

const norm = (v: unknown) => String(v).toLowerCase();

function evalCondition(c: UsageCondition, devices: RuleDevice[], get: ReadingLookup): boolean {
  const targets = c.deviceId
    ? devices.filter((d) => d.id === c.deviceId)
    : devices.filter((d) => d.category === c.category);
  return targets.some((d) => {
    const v = get(d.id, c.field);
    if (c.cmp === 'present') return v !== undefined && v !== '' && v !== 'false' && v !== 'off';
    if (v === undefined) return false;
    switch (c.cmp) {
      case 'eq':
        return norm(v) === norm(c.value);
      case 'neq':
        return norm(v) !== norm(c.value);
      case 'gt':
        return Number(v) > Number(c.value);
      case 'lt':
        return Number(v) < Number(c.value);
    }
  });
}

export function evaluateUsageRule(
  rule: UsageRule,
  devices: RuleDevice[],
  get: ReadingLookup,
): boolean {
  switch (rule.op) {
    case 'cond':
      return evalCondition(rule, devices, get);
    case 'not':
      return !evaluateUsageRule(rule.rule, devices, get);
    case 'and':
      return rule.rules.every((r) => evaluateUsageRule(r, devices, get));
    case 'or':
      return rule.rules.some((r) => evaluateUsageRule(r, devices, get));
  }
}

const cond = (category: string, field: string, value: string | boolean): UsageCondition => ({
  op: 'cond',
  category,
  field,
  cmp: 'eq',
  value,
});

/** What most rooms mean by it, until someone edits the rule. */
export const DEFAULT_USAGE_RULES: Record<UsageKind, UsageRule> = {
  av: {
    op: 'or',
    rules: [
      cond('display', 'power', 'on'),
      cond('projector', 'power', 'on'),
      cond('video_destination', 'power', 'on'),
      cond('recorder', 'recording', true),
    ],
  },
  occupied: { op: 'or', rules: [cond('occupancy_sensor', 'occupied', true)] },
};

/** The fields and categories a rule looks at, so only the readings it needs are loaded. */
export function ruleInputs(rule: UsageRule): {
  fields: Set<string>;
  deviceIds: Set<string>;
  categories: Set<string>;
} {
  const out = {
    fields: new Set<string>(),
    deviceIds: new Set<string>(),
    categories: new Set<string>(),
  };
  const walk = (r: UsageRule) => {
    if (r.op === 'cond') {
      out.fields.add(r.field);
      if (r.deviceId) out.deviceIds.add(r.deviceId);
      if (r.category) out.categories.add(r.category);
    } else if (r.op === 'not') walk(r.rule);
    else r.rules.forEach(walk);
  };
  walk(rule);
  return out;
}

/** The rule in words, for the editor's summary and for reports. */
export function describeUsageRule(rule: UsageRule, name: (c: UsageCondition) => string): string {
  const one = (c: UsageCondition) => {
    const who = name(c);
    if (c.cmp === 'present') return `${who} ${c.field} is present`;
    const op = { eq: 'is', neq: 'is not', gt: 'is above', lt: 'is below' }[c.cmp];
    return `${who} ${c.field} ${op} ${String(c.value)}`;
  };
  const go = (r: UsageRule, top: boolean): string => {
    if (r.op === 'cond') return one(r);
    if (r.op === 'not') return `not (${go(r.rule, false)})`;
    const inner = r.rules.map((c) => go(c, false)).join(r.op === 'and' ? ' AND ' : ' OR ');
    return top || r.rules.length === 1 ? inner : `(${inner})`;
  };
  return go(rule, true);
}

// ---- Sessions ------------------------------------------------------------------------------------

export interface ReadingEvent {
  /** Milliseconds since the epoch. */
  at: number;
  deviceId: string;
  field: string;
  value: string;
}
export interface Interval {
  start: number;
  end: number;
}

/**
 * Replays reading changes through a rule and returns when the room was in use. `events` must
 * include the readings in force at `from` (with `at` at or before it). A gap shorter than
 * `holdOffMs` does not end a session; a session shorter than `minOnMs` is dropped. A session still
 * running at `to` ends there.
 */
export function computeSessions(input: {
  events: ReadingEvent[];
  devices: RuleDevice[];
  rule: UsageRule;
  from: number;
  to: number;
  holdOffMs: number;
  minOnMs: number;
}): Interval[] {
  const { devices, rule, from, to } = input;
  const events = [...input.events].sort((a, b) => a.at - b.at);
  const readings = new Map<string, string>();
  const get: ReadingLookup = (d, f) => readings.get(`${d}|${f}`);
  const raw: Interval[] = [];
  let openAt: number | null = null;
  let i = 0;
  const apply = (e: ReadingEvent) => readings.set(`${e.deviceId}|${e.field}`, e.value);
  // Readings already in force when the window opens.
  while (i < events.length && events[i]!.at <= from) apply(events[i++]!);
  let state = evaluateUsageRule(rule, devices, get);
  if (state) openAt = from;
  while (i < events.length && events[i]!.at < to) {
    const at = events[i]!.at;
    while (i < events.length && events[i]!.at === at) apply(events[i++]!);
    const next = evaluateUsageRule(rule, devices, get);
    if (next && !state) openAt = at;
    if (!next && state && openAt !== null) {
      raw.push({ start: openAt, end: at });
      openAt = null;
    }
    state = next;
  }
  if (state && openAt !== null) raw.push({ start: openAt, end: to });

  // Bridge short gaps, then drop short sessions.
  const merged: Interval[] = [];
  for (const iv of raw) {
    const last = merged[merged.length - 1];
    if (last && iv.start - last.end < input.holdOffMs) last.end = iv.end;
    else merged.push({ ...iv });
  }
  return merged.filter((iv) => iv.end - iv.start >= input.minOnMs);
}

/** Whether the rule holds right now, from each device's latest readings. */
export function inUseNow(rule: UsageRule, devices: RuleDevice[], latest: ReadingLookup): boolean {
  return evaluateUsageRule(rule, devices, latest);
}

// ---- Days, hours and working time ----------------------------------------------------------------

export interface WorkingHours {
  /** 0 = Sunday. */
  days: number[];
  /** "HH:MM" */
  start: string;
  end: string;
}
export const DEFAULT_WORKING_HOURS: WorkingHours = {
  days: [1, 2, 3, 4, 5],
  start: '08:00',
  end: '18:00',
};

const toMinutes = (hhmm: string) => {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};
/** Working minutes in one working day. */
export const workMinutesPerDay = (w: WorkingHours) =>
  Math.max(0, toMinutes(w.end) - toMinutes(w.start));

export interface DayUsage {
  /** Local date, YYYY-MM-DD. */
  day: string;
  minutes: number;
  workMinutes: number;
  sessions: number;
  longestMinutes: number;
  /** Minutes in use in each local hour of the day. */
  hours: number[];
}
export interface UsageSummary {
  days: DayUsage[];
  /** Minutes in use by day of week (0 = Sunday) and local hour. */
  heat: number[][];
  totalMinutes: number;
  workMinutes: number;
  sessions: number;
  averageMinutes: number;
  medianMinutes: number;
  /** In use outside working hours. */
  afterHoursMinutes: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(ms: number, timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(p.weekday));
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    dow,
  };
}

/** A time zone name that Intl accepts, else UTC. */
export function safeTimeZone(tz: string | null | undefined): string {
  try {
    if (tz) new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Turns sessions into per-day and per-hour minutes in the site's own time zone, splitting each
 * session by the local clock, and totals what happened inside and outside working hours.
 */
export function summariseUsage(
  intervals: Interval[],
  timeZone: string,
  working: WorkingHours,
): UsageSummary {
  const tz = safeTimeZone(timeZone);
  const startMin = toMinutes(working.start);
  const endMin = toMinutes(working.end);
  const days = new Map<string, DayUsage>();
  const heat = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let afterHours = 0;
  const lengths: number[] = [];
  const day = (key: string) => {
    let d = days.get(key);
    if (!d) {
      d = {
        day: key,
        minutes: 0,
        workMinutes: 0,
        sessions: 0,
        longestMinutes: 0,
        hours: new Array<number>(24).fill(0),
      };
      days.set(key, d);
    }
    return d;
  };
  for (const iv of intervals) {
    const startParts = localParts(iv.start, tz);
    const length = (iv.end - iv.start) / 60_000;
    lengths.push(length);
    const first = day(startParts.day);
    first.sessions++;
    first.longestMinutes = Math.max(first.longestMinutes, Math.round(length));
    // Step a minute at a time along the session; whole minutes are all the resolution needed.
    for (let t = iv.start; t < iv.end; t += 60_000) {
      const minutes = Math.min(60_000, iv.end - t) / 60_000;
      const p = localParts(t, tz);
      const d = day(p.day);
      d.minutes += minutes;
      d.hours[p.hour]! += minutes;
      heat[p.dow]![p.hour]! += minutes;
      const at = p.hour * 60 + p.minute;
      if (working.days.includes(p.dow) && at >= startMin && at < endMin) d.workMinutes += minutes;
      else afterHours += minutes;
    }
  }
  const list = [...days.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({
      ...d,
      minutes: Math.round(d.minutes),
      workMinutes: Math.round(d.workMinutes),
      hours: d.hours.map((h) => Math.round(h)),
    }));
  const sorted = [...lengths].sort((a, b) => a - b);
  const median = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;
  const total = lengths.reduce((n, l) => n + l, 0);
  return {
    days: list,
    heat: heat.map((row) => row.map((v) => Math.round(v))),
    totalMinutes: Math.round(total),
    workMinutes: list.reduce((n, d) => n + d.workMinutes, 0),
    sessions: lengths.length,
    averageMinutes: lengths.length ? Math.round(total / lengths.length) : 0,
    medianMinutes: Math.round(median),
    afterHoursMinutes: Math.round(afterHours),
  };
}

/**
 * Working minutes that fall inside a window, in the site's own time zone: what a room could have
 * been in use for. A part day at either end counts only its working part.
 */
export function availableWorkMinutes(
  fromMs: number,
  toMs: number,
  tz: string,
  working: WorkingHours,
): number {
  const zone = safeTimeZone(tz);
  const startMin = toMinutes(working.start);
  const endMin = toMinutes(working.end);
  let total = 0;
  let t = fromMs;
  while (t < toMs) {
    const p = localParts(t, zone);
    // Up to the next whole local hour (or the end of the window).
    const chunk = Math.min(toMs - t, (60 - p.minute) * 60_000);
    if (working.days.includes(p.dow)) {
      const chunkStart = p.hour * 60 + p.minute;
      const chunkEnd = chunkStart + chunk / 60_000;
      total += Math.max(0, Math.min(chunkEnd, endMin) - Math.max(chunkStart, startMin));
    }
    t += chunk;
  }
  return total;
}

/** Share of available working time the room was in use, 0 to 1. Null when no working time passed. */
export function utilisation(
  summary: Pick<UsageSummary, 'workMinutes'>,
  availableMinutes: number,
): number | null {
  return availableMinutes > 0 ? Math.min(1, summary.workMinutes / availableMinutes) : null;
}

/** How many of the days from `fromMs` to `toMs` (local dates in `tz`) are working days. */
export function countWorkingDays(
  fromMs: number,
  toMs: number,
  tz: string,
  working: WorkingHours,
): number {
  const zone = safeTimeZone(tz);
  const seen = new Set<string>();
  let n = 0;
  for (let t = fromMs; t < toMs; t += 3_600_000) {
    const p = localParts(t, zone);
    if (!seen.has(p.day)) {
      seen.add(p.day);
      if (working.days.includes(p.dow)) n++;
    }
  }
  return n;
}
