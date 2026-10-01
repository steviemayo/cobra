// Calendar weeks in a site's own time zone (Monday to Sunday), shared by the server and the browser.
// Everything is an instant (a Date) until it is drawn; only the week's edges depend on the zone.

const parts = (ms: number, timeZone: string) => {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
  }).formatToParts(new Date(ms));
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? '';
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    h: Number(get('hour')),
    mi: Number(get('minute')),
    s: Number(get('second')),
    // 0 = Monday ... 6 = Sunday
    weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')),
  };
};

/** How far the zone is ahead of UTC at this instant, in ms. */
const offsetAt = (ms: number, timeZone: string) => {
  const p = parts(ms, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
};

/** The instant a wall-clock time happens in a zone. */
export function zonedToUtc(
  y: number,
  m: number,
  d: number,
  h: number,
  mi: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offsetAt(guess, timeZone);
  return new Date(guess - offsetAt(first, timeZone));
}

/** True when the zone name is one this runtime knows. */
export function validZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Midnight at the start of the Monday of the week holding `instant`, in the zone. */
export function weekStart(instant: Date, timeZone: string): Date {
  const p = parts(instant.getTime(), timeZone);
  // Walk the calendar date back to Monday; Date.UTC does the month and year rolling.
  const monday = new Date(Date.UTC(p.y, p.m - 1, p.d - p.weekday));
  return zonedToUtc(
    monday.getUTCFullYear(),
    monday.getUTCMonth() + 1,
    monday.getUTCDate(),
    0,
    0,
    timeZone,
  );
}

/** The seven days of the week starting at `start` (a Monday midnight from weekStart). */
export function weekDays(start: Date, timeZone: string): { start: Date; end: Date }[] {
  const p = parts(start.getTime() + 3_600_000, timeZone);
  const edge = (offset: number) => {
    const d = new Date(Date.UTC(p.y, p.m - 1, p.d + offset));
    return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0, timeZone);
  };
  return Array.from({ length: 7 }, (_, i) => ({ start: edge(i), end: edge(i + 1) }));
}

/** The first moment after the week that starts at `start`. */
export const weekEnd = (start: Date, timeZone: string): Date => weekDays(start, timeZone)[6]!.end;

/** Hours and minutes on the wall clock of the zone. */
export function clock(instant: Date, timeZone: string): { h: number; mi: number } {
  const p = parts(instant.getTime(), timeZone);
  return { h: p.h, mi: p.mi };
}

/** "07:30" for an instant in the zone. */
export function hhmm(instant: Date | string, timeZone: string): string {
  const { h, mi } = clock(new Date(instant), timeZone);
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/** "Mon 5 Oct" for an instant in the zone. */
export function dayLabel(instant: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(instant));
}
