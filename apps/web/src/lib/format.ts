const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

export function timeAgo(date: Date | string): string {
  const seconds = Math.round((new Date(date).getTime() - Date.now()) / 1000);
  for (const [unit, size] of UNITS)
    if (Math.abs(seconds) >= size) return RTF.format(Math.round(seconds / size), unit);
  return 'just now';
}

export function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A count of minutes as "45m", "2h" or "2h 15m". */
export function minutesLabel(m: number): string {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

/** A fraction (0 to 1) as a percentage, or "—" for null. */
export function percent(x: number | null, digits = 0): string {
  return x === null ? '—' : `${(x * 100).toFixed(digits)}%`;
}

export const ROLE_LABEL = {
  owner: 'Owner',
  dev: 'Developer',
  support: 'Support',
  customer_viewer: 'Customer viewer',
} as const;

export const ROOM_TYPE_LABEL = { meeting: 'Meeting room', training: 'Training room' } as const;
