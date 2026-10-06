import type { BrowsedPoint } from '@kestrel/model';

// Turns the flat list a device reports (dotted paths) into a cascade: pick a heading, then the next
// drop-down offers what is under it, until a value is reached. Nobody has to know the path.

/** One choice at a level: a heading to go deeper into, or a value to watch. */
export interface TreeChoice {
  /** The path part this choice stands for. */
  segment: string;
  /** How many values sit at or under it. */
  count: number;
  /** Set when this choice is itself a value (nothing deeper). */
  point?: BrowsedPoint;
}

const parts = (path: string) => path.split('.');

/** The choices under a prefix of path parts, headings and values together, in the device's own order. */
export function choicesAt(points: BrowsedPoint[], prefix: string[]): TreeChoice[] {
  const byName = new Map<string, TreeChoice>();
  for (const p of points) {
    const segs = parts(p.path);
    if (segs.length <= prefix.length || !prefix.every((s, i) => segs[i] === s)) continue;
    const segment = segs[prefix.length]!;
    const leaf = segs.length === prefix.length + 1;
    const have = byName.get(segment);
    if (have) {
      have.count += 1;
      if (leaf) have.point = p;
    } else byName.set(segment, { segment, count: 1, ...(leaf ? { point: p } : {}) });
  }
  return [...byName.values()];
}

/** The value a full path stands for, if the device reported one. */
export const pointAt = (points: BrowsedPoint[], path: string[]) =>
  points.find((p) => p.path === path.join('.'));

/**
 * The drop-downs to show for a chosen path so far: one per level, each with its choices. Stops after
 * the level whose chosen entry has nothing deeper (a value) or after the first level not yet chosen.
 */
export function cascade(
  points: BrowsedPoint[],
  chosen: string[],
): { choices: TreeChoice[]; value: string }[] {
  const levels: { choices: TreeChoice[]; value: string }[] = [];
  for (let depth = 0; ; depth += 1) {
    const choices = choicesAt(points, chosen.slice(0, depth));
    if (choices.length === 0) break;
    const value = chosen[depth] ?? '';
    levels.push({ choices, value });
    const picked = choices.find((c) => c.segment === value);
    if (!picked || (picked.point && picked.count === 1)) break;
  }
  return levels;
}
