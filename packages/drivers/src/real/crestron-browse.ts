import type { BrowsedPoint, BrowsedPoints } from '@kestrel/model';
import { digPath, isRecord } from './cresnext';
import { SENSITIVE, humanize, text } from './crestron-details';

// Lists what a Crestron unit's /Device tree holds, so a control point is picked from the unit
// itself rather than typed. The things people actually watch come first: each program slot's own
// status and each IP table entry's ONLINE/OFFLINE (the processor's own view of whether it can reach
// a device). Then every other plain value, so anything else is still one click away.

/** How many values are listed at most (the answer travels in a heartbeat). */
const MAX_POINTS = 900;
const MAX_PATH = 200;
const MAX_DEPTH = 8;
const MAX_ARRAY = 20;

const SLOTS = 'Device.Programs.ProgramInstanceLibrary';

/** "DeviceSlot1" as "1". */
const slotNumber = (key: string, slot: Record<string, unknown>) =>
  text(slot.Slot) ?? key.replace(/^DeviceSlot/, '');

/** Whatever names an IP table entry best: its description, then its model. */
const entryName = (id: string, e: Record<string, unknown>) =>
  [`IP ID ${text(e.IpId) ?? id}`, text(e.Description), text(e.Model) ?? text(e.ModelName)]
    .filter(Boolean)
    .join(' · ');

const plain = (v: unknown): string | number | boolean | undefined =>
  typeof v === 'string'
    ? v.length > 80
      ? `${v.slice(0, 77)}...`
      : v
    : typeof v === 'number' || typeof v === 'boolean'
      ? v
      : undefined;

/** The program slots' statuses and IP table entries: the values worth watching on a control system. */
function curated(tree: unknown): BrowsedPoint[] {
  const slots = digPath(tree, SLOTS);
  if (!isRecord(slots)) return [];
  const out: BrowsedPoint[] = [];
  for (const [key, slot] of Object.entries(slots).sort(([a], [b]) =>
    a.localeCompare(b, 'en', { numeric: true }),
  )) {
    if (!isRecord(slot)) continue;
    const details = slot.ProgramDetails;
    const loaded = isRecord(details) && !!(text(details.SystemName) || text(details.FriendlyName));
    const n = slotNumber(key, slot);
    const status = plain(slot.Status);
    if (loaded && status !== undefined)
      out.push({
        path: `${SLOTS}.${key}.Status`,
        label: `Program status${isRecord(details) && text(details.FriendlyName) ? `: ${text(details.FriendlyName)}` : ''}`,
        group: `Program, slot ${n}`,
        value: status,
        expect: 'Started',
      });
    const entries = digPath(slot, 'IpTable.Entries');
    if (!isRecord(entries)) continue;
    for (const [id, e] of Object.entries(entries).sort(([a], [b]) =>
      a.localeCompare(b, 'en', { numeric: true }),
    )) {
      if (!isRecord(e)) continue;
      const value = plain(e.Status);
      if (value === undefined) continue;
      out.push({
        path: `${SLOTS}.${key}.IpTable.Entries.${id}.Status`,
        label: entryName(id, e),
        group: `IP table, slot ${n}`,
        value,
        expect: 'ONLINE',
      });
    }
  }
  return out;
}

/** Every other plain value in the tree, depth first, leaving out anything that looks like a secret. */
function everythingElse(tree: unknown, skip: Set<string>, room: number) {
  const out: BrowsedPoint[] = [];
  let truncated = false;
  const walk = (node: unknown, path: string[]) => {
    if (truncated) return;
    if (path.length > MAX_DEPTH) return;
    const entries: [string, unknown][] = isRecord(node)
      ? Object.entries(node)
      : Array.isArray(node)
        ? node.slice(0, MAX_ARRAY).map((v, i) => [String(i), v] as [string, unknown])
        : [];
    for (const [key, v] of entries) {
      if (SENSITIVE.test(key)) continue;
      const here = [...path, key];
      const value = plain(v);
      if (value === undefined) {
        walk(v, here);
        continue;
      }
      const dotted = here.join('.');
      if (dotted.length > MAX_PATH || skip.has(dotted)) continue;
      if (out.length >= room) {
        truncated = true;
        return;
      }
      const parents = here.slice(1, -1).slice(-3);
      out.push({
        path: dotted,
        label: humanize(key),
        group: parents.length ? parents.map(humanize).join(' › ') : 'Device',
        value,
      });
    }
  };
  walk(tree, []);
  return { out, truncated };
}

/** Everything a person could watch on a unit, from its already-fetched /Device tree. */
export function browseTree(tree: unknown): BrowsedPoints {
  const first = curated(tree);
  const { out, truncated } = everythingElse(
    tree,
    new Set(first.map((p) => p.path)),
    Math.max(0, MAX_POINTS - first.length),
  );
  return { points: [...first, ...out], truncated };
}
