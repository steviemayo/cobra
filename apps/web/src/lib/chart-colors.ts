// The categorical chart palette (docs/decisions.md TM-20): 8 validated hues, `--chart-1` to
// `--chart-8` in globals.css. The order is the CVD-safety guarantee, not cosmetic — slots are
// assigned in a fixed order and never cycled or reassigned when the set of values changes.
export const CHART_SLOTS = 8;

/** A stable value → colour slot (1 to 8) assignment, most-significant value first. A 9th distinct
 * value and beyond all fold into "Other" (slot 0) rather than reusing or cycling a hue. */
export function assignChartSlots(valuesByWeight: string[]): Map<string, number> {
  const slots = new Map<string, number>();
  for (const v of valuesByWeight) {
    if (slots.has(v)) continue;
    slots.set(v, slots.size < CHART_SLOTS ? slots.size + 1 : 0);
  }
  return slots;
}

// Written out literally (not built from a template string) so Tailwind's scanner keeps them.
const SLOT_BG = [
  'bg-muted-foreground/30',
  'bg-chart-1',
  'bg-chart-2',
  'bg-chart-3',
  'bg-chart-4',
  'bg-chart-5',
  'bg-chart-6',
  'bg-chart-7',
  'bg-chart-8',
] as const;
const SLOT_TEXT = [
  'text-muted-foreground',
  'text-chart-1',
  'text-chart-2',
  'text-chart-3',
  'text-chart-4',
  'text-chart-5',
  'text-chart-6',
  'text-chart-7',
  'text-chart-8',
] as const;

/** Tailwind classes for a slot's fill or text. Slot 0 ("Other") is a muted neutral, not a 9th hue. */
export const chartSlotBg = (slot: number): string => SLOT_BG[slot] ?? SLOT_BG[0];
export const chartSlotText = (slot: number): string => SLOT_TEXT[slot] ?? SLOT_TEXT[0];
