import { describe, expect, it } from 'vitest';
import { expandPattern, parseSheet, rewritePoints, rewriteText } from './room-copy';
import type { ControlPoint } from './room/points';

const point = (over: Partial<ControlPoint> = {}): ControlPoint => ({
  id: 'p1',
  name: 'Room1 volume',
  type: 'level',
  address: { component: 'Room1_Gain', control: 'gain' },
  min: -60,
  max: 0,
  ...over,
});

describe('room copy helpers', () => {
  it('fills the number into a pattern, padded when asked', () => {
    expect(expandPattern('Room {n}', 3)).toBe('Room 3');
    expect(expandPattern('Room {n:2}', 3)).toBe('Room 03');
    expect(expandPattern('Boardroom', 3)).toBe('Boardroom');
  });

  it('replaces literal text, never as a pattern', () => {
    expect(rewriteText('Room1_Gain', { find: 'Room1', replace: 'Room{n}' }, 4)).toBe('Room4_Gain');
    expect(rewriteText('a.b.c', { find: '.', replace: '-' }, 1)).toBe('a-b-c');
    expect(rewriteText('x', { find: '', replace: 'y' }, 1)).toBe('x');
  });

  it('rewrites a copy of the points and keeps their ids, types and ranges', () => {
    const [p] = rewritePoints([point()], { find: 'Room1', replace: 'Room{n}' }, 2);
    expect(p).toMatchObject({
      id: 'p1',
      name: 'Room2 volume',
      type: 'level',
      min: -60,
      address: { component: 'Room2_Gain', control: 'gain' },
    });
  });

  it('does not touch the points it was given', () => {
    const original = point();
    rewritePoints([original], { find: 'Room1', replace: 'Room9' }, 1);
    expect(original.name).toBe('Room1 volume');
  });

  it('reads rows pasted from a spreadsheet or a CSV, skipping a heading and blank lines', () => {
    const pasted = ['Room\tDSP\tDisplay', 'Room 2\t10.0.0.2\t10.0.1.2', '', 'Room 3\t10.0.0.3\t10.0.1.3', ''];
    expect(parseSheet(pasted.join('\n'))).toEqual([
      ['Room 2', '10.0.0.2', '10.0.1.2'],
      ['Room 3', '10.0.0.3', '10.0.1.3'],
    ]);
    expect(parseSheet('"Room A", 10.0.0.5\r\nRoom B,10.0.0.6')).toEqual([
      ['Room A', '10.0.0.5'],
      ['Room B', '10.0.0.6'],
    ]);
    expect(parseSheet('')).toEqual([]);
  });
});
