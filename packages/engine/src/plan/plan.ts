import {
  isAvoipEndpoint,
  isVideoDestination,
  type Action,
  type Activity,
  type Device,
  type DeviceCommand,
  type RoomModel,
} from '@kestrel/model';
import { buildGraph, findRoute, type Graph } from '../validate/graph';

export interface PlanStep {
  id: string;
  deviceId: string;
  command: DeviceCommand;
  /** Step ids that must finish first. Steps with no dependencies start immediately, in parallel. */
  dependsOn: string[];
}

export interface PlanProblem {
  code: 'no_route' | 'no_source' | 'no_target';
  message: string;
}

export interface Plan {
  steps: PlanStep[];
  problems: PlanProblem[];
  /** The source this plan routes, if any. */
  sourceDeviceId?: string;
}

interface Ctx {
  model: RoomModel;
  graph: Graph;
}

class Builder {
  steps: PlanStep[] = [];
  problems: PlanProblem[] = [];
  add(deviceId: string, command: DeviceCommand, dependsOn: string[] = []): string {
    const id = `s${this.steps.length + 1}`;
    this.steps.push({ id, deviceId, command, dependsOn: [...dependsOn] });
    return id;
  }
}

const nameOf = (ctx: Ctx, id: string) => ctx.graph.devices.get(id)?.name ?? id;

function routeSteps(
  b: Builder,
  ctx: Ctx,
  src: { deviceId: string; portId?: string },
  dst: { deviceId: string; portId?: string },
) {
  const path = findRoute(ctx.graph, src, dst);
  if (!path) {
    b.problems.push({
      code: 'no_route',
      message: `${nameOf(ctx, src.deviceId)} cannot reach ${nameOf(ctx, dst.deviceId)}`,
    });
    return;
  }
  // The signal passes through AVoIP encoders and decoders, but the virtual switcher does the
  // routing (it reads the stream, points the decoder at it and waits), so they get no command.
  for (const hop of path.hops)
    if (!isAvoipEndpoint(ctx.graph.devices.get(hop.deviceId)?.category ?? 'video_matrix'))
      b.add(hop.deviceId, { type: 'route', inputPortId: hop.inPortId, outputPortId: hop.outPortId });
  const dest = ctx.graph.devices.get(dst.deviceId);
  if (dest && isVideoDestination(dest.category))
    b.add(dst.deviceId, { type: 'select_input', portId: path.destinationPortId });
}

function commandFor(action: Extract<Action, { deviceId: string }>): DeviceCommand | null {
  switch (action.type) {
    case 'power':
      return { type: 'power', on: action.on };
    case 'mute':
      return { type: 'mute', muted: action.muted };
    case 'volume':
      return { type: 'volume', level: action.level };
    case 'preset':
      return { type: 'preset', name: action.preset };
    case 'camera_preset':
      return { type: 'camera_preset', name: action.preset };
    case 'env_scene':
      return { type: 'scene', name: action.scene };
    case 'press_key':
      return { type: 'key', key: action.key };
    case 'launch_app':
      return { type: 'launch_app', appId: action.appId };
    case 'device_command':
      return action.command === 'record'
        ? { type: 'record', on: action.args.on !== false }
        : { type: 'command', name: action.command, args: action.args };
  }
}

function expandActions(b: Builder, ctx: Ctx, actions: Action[], visiting: Set<string>) {
  const produced = new Map<string, string[]>();
  for (const a of actions) {
    const start = b.steps.length;
    if (a.type === 'run_state') {
      const state = ctx.model.states.find((s) => s.id === a.stateId);
      if (state && !visiting.has(state.id))
        expandActions(b, ctx, state.actions, new Set([...visiting, state.id]));
    } else if (a.type === 'route') {
      routeSteps(
        b,
        ctx,
        { deviceId: a.sourceDeviceId, portId: a.sourcePortId },
        { deviceId: a.destinationDeviceId, portId: a.destinationPortId },
      );
    } else {
      const command = commandFor(a);
      if (command && ctx.graph.devices.has(a.deviceId)) b.add(a.deviceId, command);
    }
    const created = b.steps.slice(start);
    produced.set(
      a.id,
      created.map((s) => s.id),
    );
    const deps = a.dependsOn.flatMap((d) => produced.get(d) ?? []);
    for (const step of created) step.dependsOn.push(...deps.filter((d) => d !== step.id));
  }
}

// A display must be powered before it can take an input, launch an app or press a key.
function addImplicitDependencies(b: Builder) {
  for (const step of b.steps) {
    if (!['select_input', 'launch_app', 'key'].includes(step.command.type)) continue;
    for (const other of b.steps)
      if (
        other.deviceId === step.deviceId &&
        other.command.type === 'power' &&
        other.command.on &&
        !step.dependsOn.includes(other.id)
      )
        step.dependsOn.push(other.id);
  }
}

function finish(b: Builder, sourceDeviceId?: string): Plan {
  addImplicitDependencies(b);
  return { steps: b.steps, problems: b.problems, sourceDeviceId };
}

export interface PlanOptions {
  /** Which of the activity's sources the user picked (defaults to the first). */
  sourceId?: string;
  /** For overlays such as Record: the source currently on the displays. */
  currentSourceDeviceId?: string;
}

const CAMERA_CATEGORIES = new Set([
  'conf_camera',
  'fixed_camera',
  'ptz_camera',
  'autoframing_camera',
]);

/** Sources for an activity: its own list, or conference systems for a video call. */
export function activitySources(
  model: RoomModel,
  activity: Activity,
): { id: string; label: string; device: Device; portId?: string }[] {
  const out: { id: string; label: string; device: Device; portId?: string }[] = [];
  for (const s of activity.sources) {
    const device = model.devices.find((d) => d.id === s.deviceId);
    if (device) out.push({ id: s.id, label: s.label, device, portId: s.portId });
  }
  if (out.length === 0 && activity.kind === 'video_call')
    for (const d of model.devices)
      if (d.category === 'conference_system') out.push({ id: d.id, label: d.name, device: d });
  return out;
}

function targetDisplays(ctx: Ctx, activity: Activity): Device[] {
  const group = activity.targetGroupId
    ? ctx.model.groups.find((g) => g.id === activity.targetGroupId)
    : ctx.model.groups.find((g) => g.kind === 'display');
  if (!group) return [];
  return group.members.flatMap((id) => ctx.graph.devices.get(id) ?? []);
}

/** Everything needed to start an activity, as a dependency graph of device commands. */
export function planActivity(model: RoomModel, activity: Activity, opts: PlanOptions = {}): Plan {
  const ctx: Ctx = { model, graph: buildGraph(model) };
  const b = new Builder();
  expandActions(b, ctx, activity.actions, new Set());

  if (activity.kind === 'record') {
    const recorders = model.devices.filter((d) => d.category === 'recorder');
    const from =
      (opts.currentSourceDeviceId && ctx.graph.devices.get(opts.currentSourceDeviceId)) ||
      model.devices.find((d) => CAMERA_CATEGORIES.has(d.category));
    if (from)
      for (const r of recorders) routeSteps(b, ctx, { deviceId: from.id }, { deviceId: r.id });
    return finish(b, from?.id);
  }

  const sources = activitySources(model, activity);
  if (activity.kind === 'present' || activity.kind === 'video_call' || sources.length > 0) {
    const source = sources.find((s) => s.id === opts.sourceId) ?? sources[0];
    if (!source) {
      if (activity.kind === 'present' || activity.kind === 'video_call')
        b.problems.push({ code: 'no_source', message: `${activity.name} has no source to show` });
      return finish(b);
    }
    const displays = targetDisplays(ctx, activity);
    if (displays.length === 0)
      b.problems.push({
        code: 'no_target',
        message: `${activity.name} has no displays to show on`,
      });
    for (const d of displays)
      routeSteps(b, ctx, { deviceId: source.device.id, portId: source.portId }, { deviceId: d.id });

    // Audio follows the picture: send the source to any speakers it can reach.
    for (const d of model.devices)
      if (d.category === 'audio_destination') {
        if (
          findRoute(
            ctx.graph,
            { deviceId: source.device.id, portId: source.portId },
            { deviceId: d.id },
          )
        )
          routeSteps(
            b,
            ctx,
            { deviceId: source.device.id, portId: source.portId },
            { deviceId: d.id },
          );
      }
    return finish(b, source.device.id);
  }
  return finish(b);
}

/** The device commands a state runs, e.g. "lights down" or a custom "after hours" state. */
export function planState(model: RoomModel, stateId: string): Plan {
  const ctx: Ctx = { model, graph: buildGraph(model) };
  const b = new Builder();
  expandActions(b, ctx, [{ id: '__state', type: 'run_state', stateId, dependsOn: [] }], new Set());
  return finish(b);
}

/** Turning an overlay off (e.g. stop recording): the inverse of its device commands. */
export function planStopOverlay(model: RoomModel, activity: Activity): Plan {
  const b = new Builder();
  for (const a of activity.actions)
    if (
      a.type === 'device_command' &&
      a.command === 'record' &&
      model.devices.some((d) => d.id === a.deviceId)
    )
      b.add(a.deviceId, { type: 'record', on: false });
  return { steps: b.steps, problems: b.problems };
}
