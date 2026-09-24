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

export const ROLE_LABEL = {
  owner: 'Owner',
  dev: 'Developer',
  support: 'Support',
  customer_viewer: 'Customer viewer',
} as const;

export const ROOM_TYPE_LABEL = { meeting: 'Meeting room', training: 'Training room' } as const;
