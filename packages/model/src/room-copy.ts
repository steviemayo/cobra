import type { ControlPoint } from './room/points';

// Helpers for making copies of a room (docs/room-shapes-and-shared-devices.md, RS-4 and RS-6). Pure,
// so the portal's grid and the server use the same rules.

/**
 * Fills the number into a pattern: `{n}` is the number, `{n:2}` the number padded to two digits.
 * "Room {n:2}" with 3 is "Room 03". A pattern with no `{n}` is returned as written.
 */
export function expandPattern(pattern: string, n: number): string {
  return pattern.replace(/\{n(?::(\d{1,2}))?\}/g, (_, width: string | undefined) =>
    String(n).padStart(width ? Number(width) : 0, '0'),
  );
}

export interface TextRewrite {
  /** Literal text to look for (not a pattern). Empty means no rewrite. */
  find: string;
  /** What to put there. May use `{n}` for the copy's number. */
  replace: string;
}

/** Replaces every occurrence of `find` (literal) with `replace`, with `{n}` filled in. */
export function rewriteText(text: string, rewrite: TextRewrite | undefined, n: number): string {
  if (!rewrite || !rewrite.find) return expandPattern(text, n);
  return expandPattern(text, n).split(rewrite.find).join(expandPattern(rewrite.replace, n));
}

/**
 * A copy of a device's control points for room number `n`: each point's name and every text part of
 * its address go through the rewrite (and `{n}`). Ids, types, ranges and watches are kept.
 */
export function rewritePoints(
  points: ControlPoint[],
  rewrite: TextRewrite | undefined,
  n: number,
): ControlPoint[] {
  return points.map((p) => ({
    ...p,
    name: rewriteText(p.name, rewrite, n),
    address: Object.fromEntries(
      Object.entries(p.address).map(([k, v]) => [
        k,
        typeof v === 'string' ? rewriteText(v, rewrite, n) : v,
      ]),
    ),
  }));
}
