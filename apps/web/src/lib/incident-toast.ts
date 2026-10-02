// How new incidents are announced in the app: incidents that open together, or close together, are
// one toast that grows, not a pile of them.

export interface NewIncident {
  id: string;
  severity: string;
  title: string;
  roomName: string | null;
}

/** New incidents arriving within this long of the group's first are added to the same toast. */
export const MERGE_WINDOW_MS = 30_000;
const ROOMS_LISTED = 3;

export interface ToastGroup {
  startedAt: number;
  items: NewIncident[];
}

/** Adds newly seen incidents to the open group, or starts a new one when it has gone stale. */
export function addToGroup(
  group: ToastGroup | null,
  fresh: NewIncident[],
  now: number,
): ToastGroup {
  if (group && now - group.startedAt < MERGE_WINDOW_MS) {
    const known = new Set(group.items.map((i) => i.id));
    return { ...group, items: [...group.items, ...fresh.filter((i) => !known.has(i.id))] };
  }
  return { startedAt: now, items: fresh };
}

/** What a group says: the problem itself when it is one, otherwise a count and where they are. */
export function describeGroup(items: NewIncident[]): {
  title: string;
  description: string;
  severity: 'critical' | 'warning';
} {
  const severity = items.some((i) => i.severity === 'critical') ? 'critical' : 'warning';
  if (items.length === 1) {
    const only = items[0]!;
    return { title: only.title, description: only.roomName ?? '', severity };
  }
  const byRoom = new Map<string, number>();
  for (const i of items)
    byRoom.set(i.roomName ?? 'Other', (byRoom.get(i.roomName ?? 'Other') ?? 0) + 1);
  const rooms = [...byRoom].sort((a, b) => b[1] - a[1]);
  const shown = rooms.slice(0, ROOMS_LISTED).map(([name, n]) => (n > 1 ? `${name} (${n})` : name));
  const more = rooms.length - ROOMS_LISTED;
  return {
    title: `${items.length} new incidents`,
    description: shown.join(', ') + (more > 0 ? ` and ${more} more` : ''),
    severity,
  };
}
