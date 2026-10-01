import { describe, expect, it } from 'vitest';
import {
  PmItems,
  STARTER_PM_TEMPLATES,
  addDays,
  checkPmItems,
  countFailed,
  dueState,
  itemFailed,
  nextDueAfter,
  unanswered,
  type PmItem,
  type PmResult,
} from './pm';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const items: PmItem[] = [
  { id: 'a', label: 'Picture', type: 'passfail' },
  { id: 'b', label: 'Level', type: 'number', min: 40, max: 60, unit: 'dB' },
  { id: 'c', label: 'Notes', type: 'text' },
];
const result = (itemId: string, r: PmResult['result'], type: PmResult['type']): PmResult => ({
  itemId,
  label: itemId,
  type,
  result: r,
});

describe('checklists', () => {
  it('every starter template is valid', () => {
    for (const t of STARTER_PM_TEMPLATES) {
      expect(PmItems.safeParse(t.items).success, t.name).toBe(true);
      expect(checkPmItems(t.items), t.name).toBeNull();
    }
  });

  it('refuses repeated ids, impossible limits, and auto on a number', () => {
    expect(checkPmItems([items[0]!, { ...items[0]!, label: 'Again' }])).toMatch(/used twice/);
    expect(checkPmItems([{ id: 'x', label: 'X', type: 'number', min: 5, max: 1 }])).toMatch(
      /minimum/,
    );
    expect(checkPmItems([{ id: 'x', label: 'X', type: 'number', auto: 'device_online' }])).toMatch(
      /pass or fail/,
    );
  });

  it('counts an explicit fail and a number outside its limits, not a pass or n/a', () => {
    expect(itemFailed(items[0]!, 'fail')).toBe(true);
    expect(itemFailed(items[0]!, 'pass')).toBe(false);
    expect(itemFailed(items[0]!, 'na')).toBe(false);
    expect(itemFailed(items[1]!, 30)).toBe(true);
    expect(itemFailed(items[1]!, 50)).toBe(false);
    expect(itemFailed(items[1]!, 70)).toBe(true);
    expect(itemFailed(items[1]!, null)).toBe(false);
    expect(
      countFailed(items, [
        result('a', 'fail', 'passfail'),
        result('b', 75, 'number'),
        result('c', 'fine', 'text'),
      ]),
    ).toBe(2);
  });

  it('lists what still needs answering before sign-off; text and photos are optional', () => {
    expect(unanswered(items, [result('a', 'pass', 'passfail')])).toEqual(['Level']);
    expect(unanswered(items, [result('a', 'na', 'passfail'), result('b', 50, 'number')])).toEqual(
      [],
    );
  });
});

describe('schedules', () => {
  it('says overdue, due soon or fine', () => {
    expect(dueState(d('2026-09-29'), 7, d('2026-09-30'))).toBe('overdue');
    expect(dueState(d('2026-09-30'), 7, d('2026-09-30'))).toBe('due_soon');
    expect(dueState(d('2026-10-07'), 7, d('2026-09-30'))).toBe('due_soon');
    expect(dueState(d('2026-10-08'), 7, d('2026-09-30'))).toBe('ok');
  });

  it('keeps the rhythm for a visit near the due date and restarts from the visit when far off', () => {
    expect(nextDueAfter(d('2026-09-30'), d('2026-10-02'), 90).toISOString().slice(0, 10)).toBe(
      '2026-12-29',
    );
    expect(nextDueAfter(d('2026-09-30'), d('2026-09-28'), 90).toISOString().slice(0, 10)).toBe(
      '2026-12-29',
    );
    expect(nextDueAfter(d('2026-09-30'), d('2026-12-01'), 90).toISOString().slice(0, 10)).toBe(
      '2027-03-01',
    );
    expect(addDays(d('2026-12-31'), 1).toISOString().slice(0, 10)).toBe('2027-01-01');
  });
});
