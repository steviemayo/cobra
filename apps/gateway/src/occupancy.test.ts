import { describe, expect, it } from 'vitest';
import { occupancyTracker } from './occupancy';

const run = () => {
  const out: [boolean, string][] = [];
  return { out, track: occupancyTracker((o, d) => out.push([o, d])) };
};

describe('room occupancy from sensors', () => {
  it('reports the first reading, then only changes', () => {
    const { out, track } = run();
    track('a', false);
    track('a', false);
    track('a', true);
    track('a', true);
    track('a', false);
    expect(out).toEqual([
      [false, 'a'],
      [true, 'a'],
      [false, 'a'],
    ]);
  });

  it('is occupied while any sensor says so', () => {
    const { out, track } = run();
    track('a', true);
    track('b', true);
    track('a', false);
    expect(out).toEqual([[true, 'a']]);
    track('b', false);
    expect(out).toEqual([
      [true, 'a'],
      [false, 'b'],
    ]);
  });

  it('ignores readings with no occupancy value', () => {
    const { out, track } = run();
    track('a', undefined);
    expect(out).toEqual([]);
  });
});
