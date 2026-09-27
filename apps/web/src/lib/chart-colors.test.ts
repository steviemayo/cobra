import { describe, expect, it } from 'vitest';
import { CHART_SLOTS, assignChartSlots } from './chart-colors';

describe('assignChartSlots', () => {
  it('gives each value its own slot, in the order given', () => {
    expect(assignChartSlots(['on', 'off'])).toEqual(
      new Map([
        ['on', 1],
        ['off', 2],
      ]),
    );
  });

  it('gives repeats the slot already assigned, not a new one', () => {
    expect(assignChartSlots(['a', 'b', 'a'])).toEqual(
      new Map([
        ['a', 1],
        ['b', 2],
      ]),
    );
  });

  it('folds anything past the 8th distinct value into slot 0 ("Other"), never a 9th hue', () => {
    const values = Array.from({ length: 10 }, (_, i) => `v${i}`);
    const slots = assignChartSlots(values);
    expect([...slots.values()].filter((s) => s > 0)).toHaveLength(CHART_SLOTS);
    expect(slots.get('v8')).toBe(0);
    expect(slots.get('v9')).toBe(0);
  });

  it('is empty for no values', () => {
    expect(assignChartSlots([])).toEqual(new Map());
  });
});
