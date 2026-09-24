// Standard five-field cron ("minute hour day-of-month month day-of-week"), evaluated in a time zone.
// Supports *, lists (1,15), ranges (9-17), steps (*/5, 8-18/2), month names (JAN-DEC) and day names
// (SUN-SAT). Day of week is 0-6 with Sunday 0 (7 also means Sunday). As in classic cron, when both
// day-of-month and day-of-week are restricted, either one matching is enough.

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function field(
  raw: string,
  min: number,
  max: number,
  names: string[] | null,
  nameBase: number,
  what: string,
): Set<number> {
  const out = new Set<number>();
  const num = (s: string): number => {
    const i = names ? names.indexOf(s.toUpperCase()) : -1;
    const n = i >= 0 ? i + nameBase : /^\d+$/.test(s) ? Number(s) : NaN;
    if (!Number.isInteger(n)) throw new Error(`${what}: "${s}" is not a valid value`);
    return n;
  };
  for (const part of raw.split(',')) {
    if (!part) throw new Error(`${what}: empty item`);
    const [range, stepText] = part.split('/');
    let step = 1;
    if (stepText !== undefined) {
      step = /^\d+$/.test(stepText) ? Number(stepText) : NaN;
      if (!(step >= 1)) throw new Error(`${what}: "${stepText}" is not a valid step`);
    }
    let lo: number;
    let hi: number;
    if (range === '*') [lo, hi] = [min, max];
    else if (range!.includes('-')) {
      const [a, b] = range!.split('-');
      [lo, hi] = [num(a!), num(b!)];
    } else {
      lo = num(range!);
      hi = stepText !== undefined ? max : lo;
    }
    // Sunday may be written 7.
    const top = what === 'day of week' ? 7 : max;
    if (lo < min || hi > top || lo > hi)
      throw new Error(`${what}: ${part} is out of range (${min}-${max})`);
    for (let n = lo; n <= hi; n += step) out.add(what === 'day of week' && n === 7 ? 0 : n);
  }
  return out;
}

/** Parses a cron expression, throwing an Error whose message says what is wrong. */
export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new Error('A schedule needs 5 fields: minute hour day month weekday');
  const [mi, h, dom, mo, dow] = parts as [string, string, string, string, string];
  return {
    minute: field(mi, 0, 59, null, 0, 'minute'),
    hour: field(h, 0, 23, null, 0, 'hour'),
    dom: field(dom, 1, 31, null, 0, 'day of month'),
    month: field(mo, 1, 12, MONTHS, 1, 'month'),
    dow: field(dow, 0, 6, DAYS, 0, 'day of week'),
    domAny: dom === '*',
    dowAny: dow === '*',
  };
}

/** A problem with an expression, or null if it is fine. */
export function cronProblem(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid schedule';
  }
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  minute: number;
  hour: number;
  dom: number;
  month: number;
  dow: number;
  /** Identifies the minute, so a schedule fires once even if checked several times inside it. */
  key: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
/** The wall-clock fields of an instant in a time zone. */
export function localParts(date: Date, timezone: string): LocalParts {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(timezone, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const dow = DAYS.indexOf(String(p.weekday).toUpperCase());
  return {
    minute: Number(p.minute),
    hour: Number(p.hour) % 24,
    dom: Number(p.day),
    month: Number(p.month),
    dow,
    key: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`,
  };
}

export function cronMatches(cron: Cron, t: LocalParts): boolean {
  if (!cron.minute.has(t.minute) || !cron.hour.has(t.hour) || !cron.month.has(t.month))
    return false;
  const domOk = cron.dom.has(t.dom);
  const dowOk = cron.dow.has(t.dow);
  if (cron.domAny || cron.dowAny) return (cron.domAny || domOk) && (cron.dowAny || dowOk);
  return domOk || dowOk;
}
