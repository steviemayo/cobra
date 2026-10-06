import { describe, expect, it } from 'vitest';
import type { BrowsedPoint } from '@kestrel/model';
import { cascade, choicesAt, pointAt } from './point-tree';

const pt = (path: string): BrowsedPoint => ({ path, label: path, group: 'g', value: 1 });
const points = [
  pt('Device.Programs.Slot1.Status'),
  pt('Device.Programs.Slot2.Status'),
  pt('Device.Network.Hostname'),
];

describe('point tree', () => {
  it('lists the headings under a prefix with how much is under each', () => {
    expect(choicesAt(points, ['Device']).map((c) => [c.segment, c.count])).toEqual([
      ['Programs', 2],
      ['Network', 1],
    ]);
  });

  it('marks a value as a value', () => {
    const c = choicesAt(points, ['Device', 'Network']);
    expect(c[0]!.point?.path).toBe('Device.Network.Hostname');
  });

  it('shows one drop-down per level, stopping at the first unchosen level or at a value', () => {
    expect(cascade(points, []).length).toBe(1);
    expect(cascade(points, ['Device', 'Programs']).length).toBe(3);
    expect(cascade(points, ['Device', 'Network', 'Hostname']).length).toBe(3);
  });

  it('finds the value for a full path', () => {
    expect(pointAt(points, ['Device', 'Network', 'Hostname'])?.path).toBe('Device.Network.Hostname');
    expect(pointAt(points, ['Device'])).toBeUndefined();
  });
});
