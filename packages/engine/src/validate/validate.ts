import {
  BUILT_IN_DRIVERS,
  POINT_ROLE_INFO,
  POINT_TYPE_LABEL,
  DEVICE_CATALOG,
  type Action,
  type Capability,
  type Device,
  type RoomModel,
} from '@kestrel/model';
import {
  buildGraph,
  canRoute,
  deviceCapabilities,
  downstreamDevices,
  portKey,
  roomCapabilities,
  type Graph,
} from './graph';
import { cronProblem, isValidTimezone } from '../schedule/cron';
import type {
  IssueRef,
  Severity,
  ValidateOptions,
  ValidationIssue,
  ValidationResult,
} from './types';

class Collector {
  issues: ValidationIssue[] = [];
  add(severity: Severity, code: string, message: string, ref: IssueRef) {
    this.issues.push({ severity, code, message, ref });
  }
  error(code: string, message: string, ref: IssueRef) {
    this.add('error', code, message, ref);
  }
  warn(code: string, message: string, ref: IssueRef) {
    this.add('warning', code, message, ref);
  }
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) (seen.has(id) ? dupes : seen).add(id);
  return [...dupes];
}

function checkDuplicateIds(model: RoomModel, c: Collector) {
  const groups: [string, string[], (id: string) => IssueRef][] = [
    ['device', model.devices.map((d) => d.id), (id) => ({ kind: 'device', id })],
    ['connection', model.connections.map((x) => x.id), (id) => ({ kind: 'connection', id })],
    ['group', model.groups.map((x) => x.id), (id) => ({ kind: 'group', id })],
    ['state', model.states.map((x) => x.id), (id) => ({ kind: 'state', id })],
    ['activity', model.activities.map((x) => x.id), (id) => ({ kind: 'activity', id })],
    ['trigger', model.triggers.map((x) => x.id), (id) => ({ kind: 'trigger', id })],
  ];
  for (const [label, ids, ref] of groups)
    for (const id of duplicates(ids))
      c.error('duplicate_id', `Two ${label}s share the id "${id}"`, ref(id));
  for (const d of model.devices)
    for (const id of duplicates(d.ports.map((p) => p.id)))
      c.error('duplicate_id', `${d.name} has two ports with id "${id}"`, {
        kind: 'device',
        id: d.id,
      });
}

function checkDevices(model: RoomModel, opts: ValidateOptions, c: Collector) {
  for (const d of model.devices) {
    const info = DEVICE_CATALOG[d.category];
    if (info.controllable && !d.control)
      c.error('driver_missing', `${d.name} needs a driver or a generic protocol to be controlled`, {
        kind: 'device',
        id: d.id,
      });
    if (
      d.control?.kind === 'driver' &&
      opts.knownDrivers &&
      !opts.knownDrivers.has(d.control.driverId)
    )
      c.error('driver_unknown', `${d.name} uses unknown driver "${d.control.driverId}"`, {
        kind: 'device',
        id: d.id,
      });
  }
}

/** The AVoIP family a device's driver belongs to, when it names one. */
const familyOf = (d: Device) =>
  d.control?.kind === 'driver' ? BUILT_IN_DRIVERS[d.control.driverId]?.family : undefined;

/**
 * An AVoIP system is an encoder, a decoder and a switcher that share a handshake, so all the parts
 * a switcher joins must come from one family. Endpoints wired to nothing are also flagged.
 */
function checkAvoip(model: RoomModel, c: Collector) {
  const byId = new Map(model.devices.map((d) => [d.id, d]));
  const switcherIds = new Set(
    model.devices.filter((d) => d.category === 'video_matrix' && familyOf(d)).map((d) => d.id),
  );
  const linked = new Set<string>();
  for (const conn of model.connections) {
    const from = byId.get(conn.from.deviceId);
    const to = byId.get(conn.to.deviceId);
    if (!from || !to) continue;
    const pair =
      (switcherIds.has(to.id) && from.category === 'avoip_encoder' ? [to, from] : null) ??
      (switcherIds.has(from.id) && to.category === 'avoip_decoder' ? [from, to] : null);
    if (!pair) continue;
    const [switcher, endpoint] = pair;
    linked.add(endpoint!.id);
    const wanted = familyOf(switcher!);
    const got = familyOf(endpoint!);
    if (wanted && got && wanted !== got)
      c.error(
        'avoip_family_mismatch',
        `${endpoint!.name} is a ${got} device but ${switcher!.name} is a ${wanted} switcher. An encoder, decoder and switcher must come from the same family`,
        { kind: 'device', id: endpoint!.id },
      );
    else if (wanted && endpoint!.control && !got)
      c.warn('avoip_family_unknown', `${endpoint!.name} uses a driver that does not say which AVoIP family it belongs to`, { kind: 'device', id: endpoint!.id });
  }
  if (switcherIds.size === 0) return;
  for (const d of model.devices)
    if ((d.category === 'avoip_encoder' || d.category === 'avoip_decoder') && !linked.has(d.id))
      c.warn(
        'avoip_endpoint_unlinked',
        `${d.name} is not connected to a virtual switcher, so nothing can route to or from it`,
        { kind: 'device', id: d.id },
      );
}

const POINT_CLASS_CATEGORIES = new Set(['audio_matrix', 'lighting', 'hvac']);

/**
 * Control points of a DSP or similar device: every point must fit its driver address form, and a
 * role must fit the kind of point and the device it acts on.
 */
function checkPoints(model: RoomModel, c: Collector) {
  const ownRoles = new Map<string, string>();
  for (const d of model.devices) {
    const points = d.points ?? [];
    if (points.length === 0) continue;
    const ref: IssueRef = { kind: 'device', id: d.id };
    if (!POINT_CLASS_CATEGORIES.has(d.category)) {
      c.error('points_not_supported', `${d.name} cannot have control points; they are for a DSP or a lighting or building processor`, ref);
      continue;
    }
    const seen = new Set<string>();
    const form =
      d.control?.kind === 'driver' ? BUILT_IN_DRIVERS[d.control.driverId]?.points : undefined;
    const driverName = d.control?.kind === 'driver' ? (BUILT_IN_DRIVERS[d.control.driverId]?.name ?? 'its driver') : 'its driver';
    for (const p of points) {
      const where = `${d.name}, point "${p.name}"`;
      if (seen.has(p.id)) c.error('duplicate_id', `${d.name}: two control points share the id "${p.id}"`, ref);
      seen.add(p.id);
      if (!d.control) c.error('point_no_driver', `${where}: the device needs a driver before it can have control points`, ref);
      if (form) {
        const fields = form[p.type];
        if (!fields) c.error('point_type_unsupported', `${where}: ${driverName} does not support ${POINT_TYPE_LABEL[p.type].toLowerCase()} points`, ref);
        else
          for (const f of fields)
            if (p.address[f.key] === undefined || p.address[f.key] === '')
              c.error('point_address_missing', `${where}: needs its ${f.label.toLowerCase()}`, ref);
      }
      if (p.type === 'level' && p.min !== undefined && p.max !== undefined && p.min >= p.max)
        c.error('point_range', `${where}: the minimum must be below the maximum`, ref);
      if (!p.role) continue;
      const info = POINT_ROLE_INFO[p.role];
      if (info.type !== p.type)
        c.error('point_role_type', `${where}: the role "${info.label}" needs a ${POINT_TYPE_LABEL[info.type].toLowerCase()} point`, ref);
      if (info.needsMic) {
        const mic = p.targetId ? model.devices.find((m) => m.id === p.targetId) : undefined;
        const wanted = p.role === 'mic_privacy_mute' ? 'voice_capture_mic' : 'reinforcement_mic';
        if (!mic || mic.category !== wanted)
          c.error(
            'point_role_target',
            `${where}: the role "${info.label}" needs a ${p.role === 'mic_privacy_mute' ? 'conferencing' : 'reinforcement'} microphone to act on`,
            ref,
          );
        else {
          const key = `${p.role}:${mic.id}`;
          if (ownRoles.has(key))
            c.warn('point_role_twice', `${where}: ${mic.name} already has a "${info.label}" point (${ownRoles.get(key)})`, ref);
          ownRoles.set(key, `${d.name}, "${p.name}"`);
          if (mic.control && p.role !== 'mic_privacy_mute')
            c.warn('point_role_shadowed', `${where}: ${mic.name} has its own driver, which is used instead of this point`, ref);
        }
      } else {
        const key = `${p.role}:${d.id}`;
        if (ownRoles.has(key)) c.warn('point_role_twice', `${where}: ${d.name} already has a "${info.label}" point (${ownRoles.get(key)})`, ref);
        ownRoles.set(key, `"${p.name}"`);
      }
    }
  }
}

/**
 * A conferencing microphone feeds the call, never the room speakers. Only what can be seen from
 * the design is checked: a microphone wired straight to an audio output. (Through a DSP the design
 * cannot tell, since the DSP program decides what is mixed.)
 */
function checkMicRouting(model: RoomModel, g: Graph, c: Collector) {
  for (const conn of model.connections) {
    const from = g.devices.get(conn.from.deviceId);
    const to = g.devices.get(conn.to.deviceId);
    if (from?.category === 'voice_capture_mic' && to?.category === 'audio_destination')
      c.warn(
        'mic_to_room_speakers',
        `${from.name} is a conferencing microphone but is connected to ${to.name}. Conferencing microphones should only feed the call and the DSP`,
        { kind: 'connection', id: conn.id },
      );
  }
}

function checkConnections(model: RoomModel, g: Graph, c: Collector) {
  const inUse = new Map<string, string>();
  const outUse = new Map<string, number>();
  const connected = new Set<string>();

  for (const conn of model.connections) {
    const ref: IssueRef = { kind: 'connection', id: conn.id };
    const from = g.ports.get(portKey(conn.from.deviceId, conn.from.portId));
    const to = g.ports.get(portKey(conn.to.deviceId, conn.to.portId));
    if (!from || !to) {
      c.error(
        'connection_dangling',
        'Connection points at a device or port that does not exist',
        ref,
      );
      continue;
    }
    if (conn.from.deviceId === conn.to.deviceId)
      c.error('connection_self', 'A device cannot be connected to itself', ref);
    if (from.direction !== 'out' || to.direction !== 'in') {
      c.error(
        'connection_direction',
        'Connections must go from an output port to an input port',
        ref,
      );
      continue;
    }
    if (!(from.signal === 'av' || to.signal === 'av' || from.signal === to.signal))
      c.error(
        'connection_signal',
        `Cannot connect ${from.signal} output to ${to.signal} input`,
        ref,
      );
    const inKey = portKey(conn.to.deviceId, conn.to.portId);
    const outKey = portKey(conn.from.deviceId, conn.from.portId);
    if (inUse.has(inKey))
      c.error('input_multiple_sources', `Input "${to.name}" has more than one source`, ref);
    inUse.set(inKey, conn.id);
    outUse.set(outKey, (outUse.get(outKey) ?? 0) + 1);
    connected.add(inKey);
    connected.add(outKey);
  }

  for (const [outKey, n] of outUse)
    if (n > 1) {
      const port = g.ports.get(outKey)!;
      c.warn('output_fanout', `Output "${port.name}" feeds ${n} inputs (needs a splitter)`, {
        kind: 'port',
        id: port.id,
        parentId: outKey.split('\u0000')[0]!,
      });
    }

  for (const d of model.devices)
    for (const p of d.ports)
      if (!connected.has(portKey(d.id, p.id)))
        c.warn('port_unconnected', `${d.name}: "${p.name}" is not connected`, {
          kind: 'port',
          id: p.id,
          parentId: d.id,
        });
}

function checkGroups(model: RoomModel, g: Graph, c: Collector) {
  for (const group of model.groups) {
    const ref: IssueRef = { kind: 'group', id: group.id };
    if (group.members.length === 0)
      c.warn('group_empty', `Group "${group.name}" has no members`, ref);
    const sink: Capability = group.kind === 'display' ? 'video_sink' : 'audio_sink';
    const src: Capability[] = ['video_source', 'audio_source'];
    for (const id of group.members) {
      const d = g.devices.get(id);
      if (!d)
        c.error(
          'group_member_missing',
          `Group "${group.name}" lists a missing device "${id}"`,
          ref,
        );
      else if (!deviceCapabilities(d).has(sink))
        c.error(
          'group_member_invalid',
          `${d.name} cannot be a member of ${group.kind} group "${group.name}"`,
          ref,
        );
    }
    for (const id of group.allowedSources) {
      const d = g.devices.get(id);
      if (!d)
        c.error(
          'group_source_missing',
          `Group "${group.name}" lists a missing source "${id}"`,
          ref,
        );
      else if (!src.some((cap) => deviceCapabilities(d).has(cap)))
        c.error('group_source_invalid', `${d.name} is not a source`, ref);
    }
  }
  const membership = new Map<string, number>();
  for (const group of model.groups)
    for (const id of group.members) membership.set(id, (membership.get(id) ?? 0) + 1);
  for (const [id, n] of membership)
    if (n > 1)
      c.warn('device_in_many_groups', `${g.devices.get(id)?.name ?? id} is in ${n} groups`, {
        kind: 'device',
        id,
      });
}

const CAP_FOR_ACTION: Partial<Record<Action['type'], Capability>> = {
  power: 'power',
  preset: 'preset',
  camera_preset: 'camera_preset',
  mute: 'mute',
  volume: 'volume',
};

function checkActions(
  actions: Action[],
  owner: string,
  ref: IssueRef,
  model: RoomModel,
  g: Graph,
  c: Collector,
) {
  for (const id of duplicates(actions.map((a) => a.id)))
    c.error('duplicate_id', `${owner}: two actions share the id "${id}"`, ref);
  const ids = new Set(actions.map((a) => a.id));
  const stateIds = new Set(model.states.map((s) => s.id));

  const device = (id: string, action: Action): Device | undefined => {
    const d = g.devices.get(id);
    if (!d)
      c.error(
        'action_device_missing',
        `${owner}: ${action.type} action uses a missing device "${id}"`,
        ref,
      );
    return d;
  };

  for (const a of actions) {
    for (const dep of a.dependsOn)
      if (!ids.has(dep))
        c.error(
          'action_dependency_missing',
          `${owner}: an action depends on missing action "${dep}"`,
          ref,
        );

    if (a.type === 'run_state') {
      if (!stateIds.has(a.stateId))
        c.error('state_missing', `${owner}: runs missing state "${a.stateId}"`, ref);
      continue;
    }
    if (a.type === 'route') {
      const src = device(a.sourceDeviceId, a);
      const dst = device(a.destinationDeviceId, a);
      if (!src || !dst) continue;
      const sc = deviceCapabilities(src);
      const dc = deviceCapabilities(dst);
      if (src.category === 'voice_capture_mic' && dst.category === 'audio_destination')
        c.warn('mic_to_room_speakers', `${owner}: routes the conferencing microphone ${src.name} to ${dst.name}. Conferencing microphones should only feed the call`, ref);
      if (!sc.has('video_source') && !sc.has('audio_source'))
        c.error('route_not_source', `${owner}: ${src.name} is not a source`, ref);
      else if (!dc.has('video_sink') && !dc.has('audio_sink'))
        c.error('route_not_destination', `${owner}: ${dst.name} is not a destination`, ref);
      else if (
        !canRoute(
          g,
          { deviceId: src.id, portId: a.sourcePortId },
          { deviceId: dst.id, portId: a.destinationPortId },
        )
      )
        c.error(
          'route_impossible',
          `${owner}: ${src.name} cannot reach ${dst.name} through the connections`,
          ref,
        );
      continue;
    }

    const d = device(a.deviceId, a);
    if (!d) continue;
    const need = CAP_FOR_ACTION[a.type];
    if (need && !deviceCapabilities(d).has(need))
      c.error(
        'capability_missing',
        `${owner}: ${d.name} does not support ${a.type.replace('_', ' ')}`,
        ref,
      );
    if (a.type === 'env_scene' && !['lighting', 'hvac', 'blinds'].includes(d.category))
      c.error('capability_missing', `${owner}: ${d.name} is not an environmental device`, ref);
    if ((a.type === 'press_key' || a.type === 'launch_app') && !['display', 'video_destination'].includes(d.category))
      c.error('capability_missing', `${owner}: ${d.name} is not a display`, ref);
    if ((a.type === 'press_key' || a.type === 'launch_app') && !d.control)
      c.error('capability_missing', `${owner}: ${d.name} has no driver, so it cannot ${a.type === 'press_key' ? 'press keys' : 'launch apps'}`, ref);
    if (a.type === 'device_command' && !DEVICE_CATALOG[d.category].controllable)
      c.error('capability_missing', `${owner}: ${d.name} cannot receive commands`, ref);
  }

  if (hasCycle(actions.map((a) => [a.id, a.dependsOn.filter((x) => ids.has(x))])))
    c.error('action_cycle', `${owner}: actions depend on each other in a loop`, ref);
}

function hasCycle(edges: [string, string[]][]): boolean {
  const next = new Map(edges);
  const state = new Map<string, 1 | 2>();
  const visit = (n: string): boolean => {
    if (state.get(n) === 2) return false;
    if (state.get(n) === 1) return true;
    state.set(n, 1);
    for (const m of next.get(n) ?? []) if (visit(m)) return true;
    state.set(n, 2);
    return false;
  };
  return [...next.keys()].some(visit);
}

function checkStates(model: RoomModel, g: Graph, c: Collector) {
  for (const s of model.states)
    checkActions(s.actions, `State "${s.name}"`, { kind: 'state', id: s.id }, model, g, c);
  const edges: [string, string[]][] = model.states.map((s) => [
    s.id,
    s.actions.flatMap((a) => (a.type === 'run_state' ? [a.stateId] : [])),
  ]);
  if (hasCycle(edges)) c.error('state_cycle', 'States run each other in a loop', { kind: 'model' });
  if (!model.states.some((s) => s.kind === 'off'))
    c.warn('no_off_state', 'Room has no Off state', { kind: 'model' });
  if (model.devices.length > 0 && !model.states.some((s) => s.kind === 'on'))
    c.warn('no_on_state', 'Room has no On state', { kind: 'model' });
}

function checkActivities(model: RoomModel, g: Graph, c: Collector) {
  const have = roomCapabilities(model);
  for (const a of model.activities) {
    const ref: IssueRef = { kind: 'activity', id: a.id };
    checkActions(a.actions, `Activity "${a.name}"`, ref, model, g, c);
    for (const id of duplicates(a.sources.map((s) => s.id)))
      c.error('duplicate_id', `Activity "${a.name}": two sources share the id "${id}"`, ref);

    const missing = a.requires.filter((cap) => !have.has(cap));
    if (missing.length && !a.hidden)
      c.warn(
        'activity_unavailable',
        `"${a.name}" will not be offered: room lacks ${missing.join(', ')}`,
        ref,
      );

    if (a.kind === 'present' && a.sources.length === 0)
      c.error('present_no_sources', `"${a.name}" has no sources to choose from`, ref);
    if (a.kind === 'room_off' && !a.actions.length)
      c.warn('room_off_empty', `"${a.name}" does nothing`, ref);

    const group = a.targetGroupId ? model.groups.find((x) => x.id === a.targetGroupId) : undefined;
    if (a.targetGroupId && !group)
      c.error('group_missing', `"${a.name}" targets a missing group "${a.targetGroupId}"`, ref);
    if (a.sources.length && !a.targetGroupId)
      c.error('activity_no_target', `"${a.name}" has sources but no target group`, ref);

    for (const s of a.sources) {
      if (!g.devices.has(s.deviceId)) {
        c.error('source_missing', `"${a.name}": source "${s.label}" uses a missing device`, ref);
        continue;
      }
      if (!group) continue;
      if (!group.allowedSources.includes(s.deviceId))
        c.error(
          'source_not_allowed',
          `"${a.name}": ${s.label} is not an allowed source for "${group.name}"`,
          ref,
        );
      for (const memberId of group.members) {
        if (!g.devices.has(memberId)) continue;
        if (!canRoute(g, { deviceId: s.deviceId, portId: s.portId }, { deviceId: memberId }))
          c.error(
            'route_impossible',
            `"${a.name}": ${s.label} cannot reach ${g.devices.get(memberId)!.name}`,
            ref,
          );
      }
    }
  }
  if (model.devices.length > 0 && model.activities.length === 0)
    c.warn('no_activities', 'Room has no activities, so panels would have nothing to offer', {
      kind: 'model',
    });
  if (model.activities.length > 0 && !model.activities.some((a) => a.kind === 'room_off'))
    c.warn('no_room_off', 'Room has no Room Off activity', { kind: 'model' });
}

function checkTriggers(model: RoomModel, g: Graph, c: Collector) {
  for (const id of duplicates(
    model.triggers.flatMap((t) => (t.type === 'webhook' ? [t.hookName] : [])),
  ))
    c.error('webhook_duplicate', `Two webhook triggers share the name "${id}"`, { kind: 'model' });

  for (const t of model.triggers) {
    const ref: IssueRef = { kind: 'trigger', id: t.id };
    const run = t.run;
    if (run.type === 'state') {
      if (!model.states.some((s) => s.id === run.stateId))
        c.error('state_missing', `Trigger "${t.name}" runs a missing state`, ref);
    } else {
      const act = model.activities.find((a) => a.id === run.activityId);
      if (!act) c.error('activity_missing', `Trigger "${t.name}" runs a missing activity`, ref);
      else if (run.sourceId && !act.sources.some((s) => s.id === run.sourceId))
        c.error(
          'source_missing',
          `Trigger "${t.name}" picks a source "${act.name}" does not have`,
          ref,
        );
    }

    if (t.type === 'signal_detect') {
      const d = g.devices.get(t.deviceId);
      if (!d) {
        c.error('trigger_device_missing', `Trigger "${t.name}" uses a missing device`, ref);
        continue;
      }
      const detects =
        deviceCapabilities(d).has('signal_detect') ||
        [...downstreamDevices(g, d.id)].some((id) =>
          deviceCapabilities(g.devices.get(id)!).has('signal_detect'),
        );
      if (!detects)
        c.error(
          'signal_detect_unavailable',
          `Trigger "${t.name}": nothing downstream of ${d.name} can detect signal`,
          ref,
        );
    }
    if (t.type === 'occupancy' && !g.devices.has(t.deviceId))
      c.error('trigger_device_missing', `Trigger "${t.name}" uses a missing device`, ref);
    if (t.type === 'schedule') {
      const problem = cronProblem(t.cron);
      if (problem) c.error('cron_invalid', `Trigger "${t.name}": ${problem}`, ref);
      if (!isValidTimezone(t.timezone))
        c.error('timezone_invalid', `Trigger "${t.name}": "${t.timezone}" is not a time zone`, ref);
    }
  }
}

export function validateRoomModel(model: RoomModel, opts: ValidateOptions = {}): ValidationResult {
  const c = new Collector();
  const g = buildGraph(model);
  checkDuplicateIds(model, c);
  checkDevices(model, opts, c);
  checkConnections(model, g, c);
  checkMicRouting(model, g, c);
  checkPoints(model, c);
  checkAvoip(model, c);
  checkGroups(model, g, c);
  checkStates(model, g, c);
  checkActivities(model, g, c);
  checkTriggers(model, g, c);
  return { valid: !c.issues.some((i) => i.severity === 'error'), issues: c.issues };
}
