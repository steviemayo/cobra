import type { RoomGroupSpec } from '@kestrel/model';

/** One combined room: the set of rooms that are joined into one space. */
export interface CombinedSet {
  /** Room ids, sorted. */
  roomIds: string[];
  /** Stable identity for the set, e.g. "a+b+c". */
  key: string;
}

export interface Enumeration {
  sets: CombinedSet[];
  /** True when the cap was hit, so `sets` is incomplete. */
  truncated: boolean;
}

/** Default cap on combined rooms per group. Real buildings stay far below it. */
export const DEFAULT_MAX_COMBINED = 200;

export const combinedKey = (roomIds: readonly string[]): string => [...roomIds].sort().join('+');

/** What is wrong with a group's layout, in words. Empty means it is usable. */
export function validateGroupSpec(spec: RoomGroupSpec): string[] {
  const problems: string[] = [];
  const rooms = new Set(spec.roomIds);
  if (rooms.size !== spec.roomIds.length) problems.push('A room is listed more than once.');

  const names = new Set<string>();
  const layouts = new Set<string>();
  const touched = new Set<string>();
  for (const d of spec.dividers) {
    const label = `Divider "${d.name}"`;
    if (names.has(d.name.trim().toLowerCase())) problems.push(`${label}: the name is used twice.`);
    names.add(d.name.trim().toLowerCase());
    if (new Set(d.roomIds).size !== d.roomIds.length)
      problems.push(`${label}: lists a room more than once.`);
    if (d.roomIds.length < 2) problems.push(`${label}: must touch at least two rooms.`);
    for (const id of d.roomIds) {
      if (!rooms.has(id)) problems.push(`${label}: touches a room that is not in this group.`);
      touched.add(id);
    }
    const layout = combinedKey(d.roomIds);
    if (layouts.has(layout))
      problems.push(`${label}: another divider already joins the same rooms.`);
    layouts.add(layout);
  }
  for (const id of spec.roomIds)
    if (!touched.has(id) && spec.dividers.length > 0)
      problems.push('A room in the group has no divider, so it can never be combined.');
  return [...new Set(problems)];
}

/**
 * Every set of rooms that can be joined into one space, given the dividers. A set is possible when
 * it is the union of dividers that connect through shared rooms. Rooms that no divider joins are
 * never combined. The separate rooms are not included: they always exist.
 *
 * For a line of five rooms this is 10 sets (every run of two or more), not every subset.
 */
export function enumerateCombinedRooms(
  spec: RoomGroupSpec,
  max: number = DEFAULT_MAX_COMBINED,
): Enumeration {
  const dividers = spec.dividers.map((d) => [...new Set(d.roomIds)].sort());
  const seen = new Map<string, string[]>();
  const queue: string[][] = [];
  let truncated = false;

  const add = (rooms: string[]) => {
    const key = combinedKey(rooms);
    if (seen.has(key)) return;
    if (seen.size >= max) {
      truncated = true;
      return;
    }
    seen.set(key, rooms);
    queue.push(rooms);
  };

  for (const d of dividers) add(d);

  // Grow each set by any divider that touches it but is not already inside it.
  while (queue.length > 0 && !truncated) {
    const current = queue.shift()!;
    const inside = new Set(current);
    for (const d of dividers) {
      const overlaps = d.some((r) => inside.has(r));
      const adds = d.some((r) => !inside.has(r));
      if (overlaps && adds) add([...new Set([...current, ...d])].sort());
    }
  }

  const sets = [...seen.values()]
    .map((roomIds) => ({ roomIds, key: combinedKey(roomIds) }))
    .sort((a, b) => a.roomIds.length - b.roomIds.length || a.key.localeCompare(b.key));
  return { sets, truncated };
}

/**
 * Which combined rooms are live for a given set of open dividers: the connected groups of rooms,
 * ignoring rooms that are still separate.
 */
export function liveCombinations(
  spec: RoomGroupSpec,
  openDividerIds: readonly string[],
): CombinedSet[] {
  const open = new Set(openDividerIds);
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = parent.get(x) ?? x;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root;
    parent.set(x, root);
    return root;
  };
  for (const d of spec.dividers) {
    if (!open.has(d.id)) continue;
    for (const r of d.roomIds.slice(1)) parent.set(find(r), find(d.roomIds[0]!));
  }
  const groups = new Map<string, string[]>();
  for (const d of spec.dividers)
    if (open.has(d.id))
      for (const r of d.roomIds) {
        const root = find(r);
        groups.set(root, [...new Set([...(groups.get(root) ?? []), r])]);
      }
  return [...groups.values()]
    .map((roomIds) => ({ roomIds: roomIds.sort(), key: combinedKey(roomIds) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
