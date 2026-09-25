import type { Device, RoomModel } from '@kestrel/model';

export type ChangeKind = 'added' | 'removed' | 'changed';
export type ChangeArea =
  'device' | 'connection' | 'group' | 'state' | 'activity' | 'trigger' | 'setting';

export interface Change {
  kind: ChangeKind;
  area: ChangeArea;
  /** What changed, in words: "Display 1", "Laptop 1 to Video matrix". */
  label: string;
  /** Specific differences for a `changed` item. */
  details: string[];
}

const AREA_ORDER: ChangeArea[] = [
  'device',
  'connection',
  'group',
  'state',
  'activity',
  'trigger',
  'setting',
];

/** JSON with sorted keys, so structural equality ignores key order. */
function stable(v: unknown): string {
  const order = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(order);
    if (x && typeof x === 'object')
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, y]) => [k, order(y)]),
      );
    return x;
  };
  return JSON.stringify(order(v));
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);

function byId<T extends { id: string }>(list: T[]): Map<string, T> {
  return new Map(list.map((x) => [x.id, x]));
}

function list(items: string[]): string {
  return items.length ? items.join(', ') : 'none';
}

function keysChanged(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => !same(a[k], b[k]))
    .sort();
}

function compare<T extends { id: string }>(
  area: ChangeArea,
  before: T[],
  after: T[],
  label: (x: T) => string,
  differences: (a: T, b: T) => string[],
  out: Change[],
) {
  const a = byId(before);
  const b = byId(after);
  for (const [id, x] of b) {
    const old = a.get(id);
    if (!old) out.push({ kind: 'added', area, label: label(x), details: [] });
    else {
      const details = differences(old, x);
      if (details.length) out.push({ kind: 'changed', area, label: label(x), details });
    }
  }
  for (const [id, x] of a)
    if (!b.has(id)) out.push({ kind: 'removed', area, label: label(x), details: [] });
}

function deviceDetails(a: Device, b: Device): string[] {
  const out: string[] = [];
  if (a.name !== b.name) out.push(`renamed from “${a.name}”`);
  if (a.category !== b.category) out.push(`type changed from ${a.category} to ${b.category}`);
  if (!same(a.control, b.control)) out.push('control method changed');
  const settings = keysChanged(a.settings, b.settings);
  // Setting values can hold passwords, so only say which settings changed.
  if (settings.length) out.push(`settings changed (${settings.join(', ')})`);
  const pa = byId(a.ports);
  const pb = byId(b.ports);
  const added = b.ports.filter((p) => !pa.has(p.id)).map((p) => p.name);
  const removed = a.ports.filter((p) => !pb.has(p.id)).map((p) => p.name);
  if (added.length) out.push(`ports added: ${list(added)}`);
  if (removed.length) out.push(`ports removed: ${list(removed)}`);
  for (const p of b.ports) {
    const old = pa.get(p.id);
    if (old && !same(old, p)) out.push(`port “${p.name}” changed`);
  }
  return out;
}

function flatten(prefix: string, value: unknown, out: Record<string, unknown>) {
  if (value && typeof value === 'object' && !Array.isArray(value))
    for (const [k, v] of Object.entries(value)) flatten(prefix ? `${prefix}.${k}` : k, v, out);
  else out[prefix] = value;
}

const SETTING_LABEL: Record<string, string> = {
  defaultVolume: 'Default volume',
  'autoOff.enabled': 'Auto-off',
  'autoOff.warnSeconds': 'Auto-off warning time',
  'autoOff.idleSeconds': 'Auto-off idle time',
  sourceConflictSeconds: 'Second-source switch time',
  'userControls.lights': 'Lights control on panel',
  'userControls.blinds': 'Blinds control on panel',
  'userControls.camera': 'Camera control on panel',
  'panel.idle.action': 'Touch to begin action',
  'panel.idle.activityId': 'Touch to begin activity',
  'panel.idle.timeoutMinutes': 'Panel idle timeout (minutes)',
  'panel.idle.supportText': 'Idle screen support text',
  'panel.idle.supportUrl': 'Idle screen support link',
};

/**
 * What changed between two designs, in words. `before` null means there is no earlier release, so
 * everything is reported as added.
 */
export function diffRoomModels(before: RoomModel | null, after: RoomModel): Change[] {
  const empty: RoomModel = {
    ...after,
    devices: [],
    connections: [],
    groups: [],
    states: [],
    activities: [],
    triggers: [],
  };
  const a = before ?? empty;
  const out: Change[] = [];
  const nameOf = (id: string, ...models: RoomModel[]) => {
    for (const m of models) {
      const d = m.devices.find((x) => x.id === id);
      if (d) return d.name;
    }
    return id;
  };
  const portOf = (deviceId: string, portId: string, ...models: RoomModel[]) => {
    for (const m of models) {
      const p = m.devices.find((x) => x.id === deviceId)?.ports.find((x) => x.id === portId);
      if (p) return p.name;
    }
    return portId;
  };

  compare('device', a.devices, after.devices, (d) => `${d.name}`, deviceDetails, out);

  const endpoint = (e: { deviceId: string; portId: string }) =>
    `${nameOf(e.deviceId, after, a)} ${portOf(e.deviceId, e.portId, after, a)}`;
  compare(
    'connection',
    a.connections,
    after.connections,
    (c) => `${endpoint(c.from)} to ${endpoint(c.to)}`,
    (x, y) => (same(x.from, y.from) && same(x.to, y.to) ? [] : ['endpoints changed']),
    out,
  );

  const names = (ids: string[]) => ids.map((id) => nameOf(id, after, a));
  compare(
    'group',
    a.groups,
    after.groups,
    (g) => g.name,
    (x, y) => {
      const d: string[] = [];
      if (x.name !== y.name) d.push(`renamed from “${x.name}”`);
      if (x.mode !== y.mode) d.push(`mode changed to ${y.mode}`);
      if (!same(x.members, y.members)) d.push(`members now ${list(names(y.members))}`);
      if (!same(x.allowedSources, y.allowedSources))
        d.push(`allowed sources now ${list(names(y.allowedSources))}`);
      return d;
    },
    out,
  );

  compare(
    'state',
    a.states,
    after.states,
    (s) => s.name,
    (x, y) => {
      const d: string[] = [];
      if (x.name !== y.name) d.push(`renamed from “${x.name}”`);
      if (x.kind !== y.kind) d.push(`kind changed to ${y.kind}`);
      if (!same(x.actions, y.actions))
        d.push(`actions changed (${x.actions.length} to ${y.actions.length})`);
      return d;
    },
    out,
  );

  compare(
    'activity',
    a.activities,
    after.activities,
    (x) => x.name,
    (x, y) => {
      const d: string[] = [];
      if (x.name !== y.name) d.push(`renamed from “${x.name}”`);
      if (x.hidden !== y.hidden) d.push(y.hidden ? 'now hidden' : 'now shown');
      if (!same(x.sources, y.sources)) d.push(`sources now ${list(y.sources.map((s) => s.label))}`);
      if (x.targetGroupId !== y.targetGroupId) d.push('target group changed');
      if (!same(x.requires, y.requires)) d.push('required equipment changed');
      if (!same(x.actions, y.actions))
        d.push(`actions changed (${x.actions.length} to ${y.actions.length})`);
      return d;
    },
    out,
  );

  compare(
    'trigger',
    a.triggers,
    after.triggers,
    (t) => t.name,
    (x, y) => {
      const d: string[] = [];
      if (x.name !== y.name) d.push(`renamed from “${x.name}”`);
      if (x.enabled !== y.enabled) d.push(y.enabled ? 'enabled' : 'disabled');
      if (!same({ ...x, name: 0, enabled: 0 }, { ...y, name: 0, enabled: 0 }))
        d.push('what it does or when changed');
      return d;
    },
    out,
  );

  if (before) {
    const fa: Record<string, unknown> = {};
    const fb: Record<string, unknown> = {};
    flatten('', before.settings, fa);
    flatten('', after.settings, fb);
    for (const key of keysChanged(fa, fb))
      out.push({
        kind: 'changed',
        area: 'setting',
        label: SETTING_LABEL[key] ?? key,
        details: [`${String(fa[key])} to ${String(fb[key])}`],
      });
  }

  return out.sort(
    (x, y) =>
      AREA_ORDER.indexOf(x.area) - AREA_ORDER.indexOf(y.area) ||
      x.label.localeCompare(y.label) ||
      x.kind.localeCompare(y.kind),
  );
}

export function summariseChanges(changes: Change[]): string {
  if (changes.length === 0) return 'No changes';
  const n = (k: ChangeKind) => changes.filter((c) => c.kind === k).length;
  return [
    n('added') && `${n('added')} added`,
    n('changed') && `${n('changed')} changed`,
    n('removed') && `${n('removed')} removed`,
  ]
    .filter(Boolean)
    .join(', ');
}
