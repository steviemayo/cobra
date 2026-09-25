import {
  RoomModel,
  type Action,
  type Activity,
  type ActivityKind,
  type Group,
  type RoomState,
} from '@kestrel/model';

export interface CombinedMember {
  /** Short, unique, letters/numbers/underscore. Prefixes this room's ids in the combined room. */
  key: string;
  /** The room's name, shown in front of its devices and sources. */
  name: string;
  model: RoomModel;
}

const MAX_ID = 64;

/** A short key for a room name that is safe to use inside ids: "Room 101" becomes "room_101". */
export function memberKey(name: string, taken: ReadonlySet<string> = new Set()): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 12) || 'room';
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}${i}`;
  return key;
}

const trim = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

/**
 * The starting program for a combined room: every member's devices, connections, groups and states
 * side by side (ids prefixed by the member, names prefixed by the room), one activity per kind with
 * the members' sources together, and one display group and one audio group spanning all members.
 *
 * It cannot know how rooms are wired to each other, so cross-room routes are left for the dev to
 * add, and triggers are not copied. The validator flags whatever is missing.
 */
export function deriveCombinedModel(members: CombinedMember[]): RoomModel {
  if (members.length < 2) throw new Error('A combined room needs at least two member rooms.');
  const keys = new Set<string>();
  for (const m of members) {
    if (keys.has(m.key)) throw new Error(`Two member rooms share the key "${m.key}".`);
    keys.add(m.key);
  }

  // Prefix an id with its room's key. Ids are short in practice; the cut is a safety net.
  const id = (key: string, local: string): string => `${key}__${local}`.slice(0, MAX_ID);

  const remapAction = (key: string, a: Action): Action => {
    const next = { ...a, id: id(key, a.id), dependsOn: a.dependsOn.map((d) => id(key, d)) };
    switch (next.type) {
      case 'route':
        return {
          ...next,
          sourceDeviceId: id(key, next.sourceDeviceId),
          destinationDeviceId: id(key, next.destinationDeviceId),
        };
      case 'run_state':
        return { ...next, stateId: id(key, next.stateId) };
      default:
        return 'deviceId' in next ? { ...next, deviceId: id(key, next.deviceId) } : next;
    }
  };

  const devices = members.flatMap((m) =>
    m.model.devices.map((d) => ({
      ...structuredClone(d),
      id: id(m.key, d.id),
      name: trim(`${m.name}: ${d.name}`, 80),
    })),
  );

  const connections = members.flatMap((m) =>
    m.model.connections.map((c) => ({
      ...c,
      id: id(m.key, c.id),
      from: { ...c.from, deviceId: id(m.key, c.from.deviceId) },
      to: { ...c.to, deviceId: id(m.key, c.to.deviceId) },
    })),
  );

  const memberGroups: Group[] = members.flatMap((m) =>
    m.model.groups.map((g) => ({
      ...g,
      id: id(m.key, g.id),
      name: trim(`${m.name}: ${g.name}`, 80),
      members: g.members.map((d) => id(m.key, d)),
      allowedSources: g.allowedSources.map((d) => id(m.key, d)),
    })),
  );

  // One group per kind across every member, so an activity can target all the displays at once.
  const together = (kind: 'display' | 'audio', gid: string, name: string): Group | undefined => {
    const of = memberGroups.filter((g) => g.kind === kind);
    if (of.length === 0) return undefined;
    return {
      id: gid,
      name,
      kind,
      members: [...new Set(of.flatMap((g) => g.members))],
      allowedSources: [...new Set(of.flatMap((g) => g.allowedSources))],
      mode: 'follow',
    };
  };
  const allDisplays = together('display', 'all_displays', 'All displays');
  const allAudio = together('audio', 'all_audio', 'All audio');
  const groups = [...memberGroups, ...[allDisplays, allAudio].filter((g): g is Group => !!g)];

  const states: RoomState[] = members.flatMap((m) =>
    m.model.states.map((s) => ({
      ...s,
      id: id(m.key, s.id),
      name: trim(`${m.name}: ${s.name}`, 80),
      actions: s.actions.map((a) => remapAction(m.key, a)),
    })),
  );

  // One activity per kind. Custom activities stay separate, one per member.
  const activities: Activity[] = [];
  const kinds: ActivityKind[] = ['present', 'video_call', 'record', 'room_off'];
  for (const kind of kinds) {
    const parts = members.flatMap((m) =>
      m.model.activities.filter((a) => a.kind === kind).map((a) => ({ m, a })),
    );
    if (parts.length === 0) continue;
    const first = parts[0]!.a;
    const targetsDisplays = parts.some((p) => p.a.targetGroupId);
    activities.push({
      id: kind,
      name: first.name,
      kind,
      icon: first.icon,
      hidden: parts.every((p) => p.a.hidden),
      requires: [...new Set(parts.flatMap((p) => p.a.requires))],
      sources: parts.flatMap(({ m, a }) =>
        a.sources.map((s) => ({
          id: id(m.key, s.id),
          label: trim(`${m.name}: ${s.label}`, 60),
          deviceId: id(m.key, s.deviceId),
          ...(s.portId ? { portId: s.portId } : {}),
        })),
      ),
      ...(targetsDisplays && allDisplays ? { targetGroupId: allDisplays.id } : {}),
      actions: parts.flatMap(({ m, a }) => a.actions.map((x) => remapAction(m.key, x))),
    });
  }
  for (const m of members)
    for (const a of m.model.activities.filter((x) => x.kind === 'custom'))
      activities.push({
        ...a,
        id: id(m.key, a.id),
        name: trim(`${m.name}: ${a.name}`, 60),
        sources: a.sources.map((s) => ({
          ...s,
          id: id(m.key, s.id),
          deviceId: id(m.key, s.deviceId),
        })),
        targetGroupId: a.targetGroupId ? id(m.key, a.targetGroupId) : undefined,
        actions: a.actions.map((x) => remapAction(m.key, x)),
      });

  const first = members[0]!.model;
  return RoomModel.parse({
    roomType: first.roomType,
    settings: structuredClone(first.settings),
    devices,
    connections,
    groups,
    states,
    activities,
    triggers: [],
  });
}
