import { z } from 'zod';

// Preventative maintenance (docs/pivot-monitoring.md): checklists run on a schedule, with the items
// monitoring can answer filled in from live data, and a signed-off record that is never edited.
// Everything here is pure.

export const PM_ITEM_TYPES = ['passfail', 'number', 'text', 'photo'] as const;
/** Items monitoring can answer for itself, from what a room or device reports. */
export const PM_AUTO_SOURCES = [
  'devices_online',
  'no_open_incidents',
  'no_config_drift',
  'device_online',
  'firmware_known',
] as const;
export type PmAutoSource = (typeof PM_AUTO_SOURCES)[number];
export const PM_AUTO_LABEL: Record<PmAutoSource, string> = {
  devices_online: 'Every monitored device in the room is answering',
  no_open_incidents: 'No open incidents',
  no_config_drift: 'Nothing is drifted from its settings',
  device_online: 'The device is answering',
  firmware_known: 'The device reports its firmware',
};

export const PmItem = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/, 'letters, numbers, - and _ only'),
  label: z.string().trim().min(1).max(200),
  type: z.enum(PM_ITEM_TYPES),
  unit: z.string().max(20).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  auto: z.enum(PM_AUTO_SOURCES).optional(),
});
export type PmItem = z.infer<typeof PmItem>;
export const PmItems = z.array(PmItem).min(1).max(60);

export const PmResultValue = z.union([
  z.enum(['pass', 'fail', 'na']),
  z.number(),
  z.string().max(2000),
]);
export const PmResult = z.object({
  itemId: z.string(),
  label: z.string(),
  type: z.enum(PM_ITEM_TYPES),
  result: PmResultValue.nullable(),
  note: z.string().max(2000).optional(),
  /** What monitoring said, and when, when this item was filled in from live data. */
  auto: z.object({ value: z.string().max(200), at: z.string() }).optional(),
});
export type PmResult = z.infer<typeof PmResult>;

/** A checklist with unique item ids, and numbers with sensible limits. */
export function checkPmItems(items: PmItem[]): string | null {
  const seen = new Set<string>();
  for (const i of items) {
    if (seen.has(i.id)) return `"${i.id}" is used twice`;
    seen.add(i.id);
    if (i.min !== undefined && i.max !== undefined && i.min > i.max)
      return `${i.label}: the minimum is above the maximum`;
    if (i.auto && i.type !== 'passfail')
      return `${i.label}: only pass or fail items can be filled in from live data`;
  }
  return null;
}

/** Whether one filled-in item counts as failed: an explicit fail, or a number outside its limits. */
export function itemFailed(
  item: Pick<PmItem, 'type' | 'min' | 'max'>,
  result: PmResult['result'],
): boolean {
  if (result === null) return false;
  if (item.type === 'passfail') return result === 'fail';
  if (item.type === 'number' && typeof result === 'number')
    return (
      (item.min !== undefined && result < item.min) || (item.max !== undefined && result > item.max)
    );
  return false;
}

/** Items still to be answered before a run can be signed (n/a counts as answered). */
export function unanswered(items: PmItem[], results: PmResult[]): string[] {
  const by = new Map(results.map((r) => [r.itemId, r]));
  return items
    .filter((i) => {
      if (i.type === 'photo' || i.type === 'text') return false;
      const r = by.get(i.id)?.result;
      return r === null || r === undefined || r === '';
    })
    .map((i) => i.label);
}

export function countFailed(items: PmItem[], results: PmResult[]): number {
  const by = new Map(items.map((i) => [i.id, i]));
  return results.filter((r) => {
    const item = by.get(r.itemId);
    return item ? itemFailed(item, r.result) : false;
  }).length;
}

// ---- Schedules ---------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
/** The date `days` after `from` (both as dates, midnight UTC). */
export const addDays = (from: Date, days: number) =>
  new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + days));
export const toDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export type DueState = 'overdue' | 'due_soon' | 'ok';

/** Overdue once the due date has passed, due soon within the lead time, otherwise fine. */
export function dueState(nextDueOn: Date, leadDays: number, now: Date): DueState {
  const today = toDay(now).getTime();
  const due = toDay(nextDueOn).getTime();
  if (today > due) return 'overdue';
  if (due - today <= leadDays * DAY_MS) return 'due_soon';
  return 'ok';
}

/** Whole days late (positive) or still to go (negative). */
export const daysLate = (nextDueOn: Date, now: Date) =>
  Math.round((toDay(now).getTime() - toDay(nextDueOn).getTime()) / DAY_MS);

/**
 * The next due date after a visit signed on `signedOn`. A visit made early or late keeps to the
 * schedule when it is close to the due date and otherwise restarts the interval from the visit.
 */
export function nextDueAfter(dueOn: Date, signedOn: Date, intervalDays: number): Date {
  const late = daysLate(dueOn, signedOn);
  // Within a fifth of the interval of the due date, keep the rhythm; further off, count from the visit.
  return Math.abs(late) <= Math.floor(intervalDays / 5)
    ? addDays(dueOn, intervalDays)
    : addDays(signedOn, intervalDays);
}

export const INTERVAL_CHOICES = [
  { days: 30, label: 'Monthly' },
  { days: 90, label: 'Quarterly' },
  { days: 180, label: 'Every six months' },
  { days: 365, label: 'Yearly' },
] as const;

// ---- Starter checklists ------------------------------------------------------------------------

export interface PmStarterTemplate {
  name: string;
  appliesTo: 'room' | 'device';
  category?: string;
  items: PmItem[];
}

const item = (id: string, label: string, extra: Partial<PmItem> = {}): PmItem => ({
  id,
  label,
  type: 'passfail',
  ...extra,
});

export const STARTER_PM_TEMPLATES: PmStarterTemplate[] = [
  {
    name: 'Meeting room check',
    appliesTo: 'room',
    items: [
      item('online', 'Every monitored device answers', { auto: 'devices_online' }),
      item('incidents', 'No open incidents', { auto: 'no_open_incidents' }),
      item('drift', 'Nothing has drifted from its settings', { auto: 'no_config_drift' }),
      item('display', 'Display shows a clear picture from a laptop'),
      item('audio', 'Speakers play clearly and the volume is comfortable'),
      item('mic', 'Microphone picks up a voice and is not muted'),
      item('cables', 'Cables and wall plates are secure and undamaged'),
      item('clean', 'Screens, remotes and the table are clean'),
      item('notes', 'Anything else worth recording', { type: 'text' }),
    ],
  },
  {
    name: 'Training room check',
    appliesTo: 'room',
    items: [
      item('online', 'Every monitored device answers', { auto: 'devices_online' }),
      item('incidents', 'No open incidents', { auto: 'no_open_incidents' }),
      item('drift', 'Nothing has drifted from its settings', { auto: 'no_config_drift' }),
      item('display', 'Every display shows a clear picture'),
      item('audio', 'Speakers and lectern microphone work'),
      item('camera', 'Camera picture is clear and presets recall'),
      item('lectern', 'Lectern inputs and the wireless presenter work'),
      item('recording', 'A test recording starts and stops'),
      item('clean', 'Screens, lectern and controls are clean'),
      item('notes', 'Anything else worth recording', { type: 'text' }),
    ],
  },
  {
    name: 'Display check',
    appliesTo: 'device',
    category: 'display',
    items: [
      item('online', 'The display is answering', { auto: 'device_online' }),
      item('firmware', 'The display reports its firmware', { auto: 'firmware_known' }),
      item('picture', 'Picture is clear with no dead pixels or burn-in'),
      item('vents', 'Vents are clear of dust'),
      item('mount', 'Mount and cables are secure'),
      item('hours', 'Hours in use', { type: 'number', unit: 'h' }),
    ],
  },
  {
    name: 'Camera check',
    appliesTo: 'device',
    category: 'ptz_camera',
    items: [
      item('online', 'The camera is answering', { auto: 'device_online' }),
      item('picture', 'Picture is sharp and correctly exposed'),
      item('presets', 'Presets recall to the right positions'),
      item('lens', 'Lens is clean'),
      item('mount', 'Mount and cabling are secure'),
    ],
  },
  {
    name: 'Audio processor check',
    appliesTo: 'device',
    category: 'audio_matrix',
    items: [
      item('online', 'The processor is answering', { auto: 'device_online' }),
      item('drift', 'Nothing has drifted from its settings', { auto: 'no_config_drift' }),
      item('levels', 'Test tone reaches every output at the right level'),
      item('power', 'Power supply and vents are clear'),
    ],
  },
];
