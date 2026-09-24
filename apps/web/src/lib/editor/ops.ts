import {
  ACTIVITY_DEFAULTS,
  DEVICE_CATALOG,
  Device,
  ROOM_TYPES,
  deviceFromCategory,
  type Action,
  type ActionType,
  type Activity,
  type Capability,
  type DeviceCategory,
  type PortDirection,
  type RoomModel,
  type RoomState,
  type SignalKind,
  type Trigger,
} from '@kestrel/model';

// All ops mutate the model they are given. The editor hands them a fresh clone each time.

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const root = slug(base) || 'item';
  if (!used.has(root)) return root;
  for (let i = 2; ; i++) if (!used.has(`${root}-${i}`)) return `${root}-${i}`;
}

export function hasCapability(model: RoomModel, deviceId: string, cap: Capability): boolean {
  const d = model.devices.find((x) => x.id === deviceId);
  return !!d && deviceCaps(d).has(cap);
}

export function deviceCaps(d: Device): Set<Capability> {
  return new Set([...DEVICE_CATALOG[d.category].capabilities, ...d.extraCapabilities]);
}

export function devicesWith(model: RoomModel, ...caps: Capability[]): Device[] {
  return model.devices.filter((d) => caps.some((c) => deviceCaps(d).has(c)));
}

export function addDevice(model: RoomModel, category: DeviceCategory, name?: string): Device {
  const label = name?.trim() || DEVICE_CATALOG[category].label;
  const id = uniqueId(
    label,
    model.devices.map((d) => d.id),
  );
  const device = Device.parse(deviceFromCategory(category, id, label));
  model.devices.push(device);
  return device;
}

export function removeDevice(model: RoomModel, deviceId: string) {
  model.devices = model.devices.filter((d) => d.id !== deviceId);
  model.connections = model.connections.filter(
    (c) => c.from.deviceId !== deviceId && c.to.deviceId !== deviceId,
  );
  for (const g of model.groups) {
    g.members = g.members.filter((id) => id !== deviceId);
    g.allowedSources = g.allowedSources.filter((id) => id !== deviceId);
  }
  for (const a of model.activities) a.sources = a.sources.filter((s) => s.deviceId !== deviceId);
  model.triggers = model.triggers.filter((t) => !('deviceId' in t && t.deviceId === deviceId));
}

export function addPort(
  model: RoomModel,
  deviceId: string,
  port: { name: string; direction: PortDirection; signal: SignalKind },
) {
  const d = model.devices.find((x) => x.id === deviceId);
  if (!d) return;
  const prefix = port.direction === 'in' ? 'in' : 'out';
  const id = uniqueId(
    `${prefix}${d.ports.filter((p) => p.direction === port.direction).length + 1}`,
    d.ports.map((p) => p.id),
  );
  d.ports.push({
    id,
    name:
      port.name.trim() || `${port.direction === 'in' ? 'Input' : 'Output'} ${d.ports.length + 1}`,
    direction: port.direction,
    signal: port.signal,
  });
}

export function removePort(model: RoomModel, deviceId: string, portId: string) {
  const d = model.devices.find((x) => x.id === deviceId);
  if (!d) return;
  d.ports = d.ports.filter((p) => p.id !== portId);
  model.connections = model.connections.filter(
    (c) =>
      !(c.from.deviceId === deviceId && c.from.portId === portId) &&
      !(c.to.deviceId === deviceId && c.to.portId === portId),
  );
  for (const a of model.activities)
    for (const s of a.sources) if (s.deviceId === deviceId && s.portId === portId) delete s.portId;
}

export type ConnectResult = { ok: true } | { ok: false; reason: string };

export function addConnection(
  model: RoomModel,
  from: { deviceId: string; portId: string },
  to: { deviceId: string; portId: string },
): ConnectResult {
  const port = (r: { deviceId: string; portId: string }) =>
    model.devices.find((d) => d.id === r.deviceId)?.ports.find((p) => p.id === r.portId);
  const a = port(from);
  const b = port(to);
  if (!a || !b) return { ok: false, reason: 'Port not found' };
  if (a.direction !== 'out' || b.direction !== 'in')
    return { ok: false, reason: 'Connect an output to an input' };
  if (from.deviceId === to.deviceId)
    return { ok: false, reason: 'Cannot connect a device to itself' };
  if (model.connections.some((c) => c.to.deviceId === to.deviceId && c.to.portId === to.portId))
    return { ok: false, reason: 'That input already has a source' };
  const id = uniqueId(
    `${from.deviceId}-${from.portId}-to-${to.deviceId}-${to.portId}`,
    model.connections.map((c) => c.id),
  );
  model.connections.push({ id, from: { ...from }, to: { ...to } });
  return { ok: true };
}

export function removeConnection(model: RoomModel, connectionId: string) {
  model.connections = model.connections.filter((c) => c.id !== connectionId);
}

export function nextActionId(actions: Action[]): string {
  return `a${Math.max(0, ...actions.map((a) => Number(/^a(\d+)$/.exec(a.id)?.[1] ?? 0))) + 1}`;
}

export const ACTION_TYPES: { type: ActionType; label: string }[] = [
  { type: 'power', label: 'Power' },
  { type: 'route', label: 'Route signal' },
  { type: 'preset', label: 'Recall preset' },
  { type: 'camera_preset', label: 'Camera preset' },
  { type: 'mute', label: 'Mute' },
  { type: 'volume', label: 'Set volume' },
  { type: 'device_command', label: 'Device command' },
  { type: 'env_scene', label: 'Environment scene' },
  { type: 'run_state', label: 'Run state' },
];

const ACTION_CAP: Partial<Record<ActionType, Capability[]>> = {
  power: ['power'],
  preset: ['preset'],
  camera_preset: ['camera_preset'],
  mute: ['mute'],
  volume: ['volume'],
  env_scene: ['lighting', 'blinds', 'hvac'],
};

/** Devices an action of this type can target. */
export function actionTargets(model: RoomModel, type: ActionType): Device[] {
  if (type === 'device_command')
    return model.devices.filter((d) => DEVICE_CATALOG[d.category].controllable);
  const caps = ACTION_CAP[type];
  return caps ? devicesWith(model, ...caps) : model.devices;
}

/** Build a new action with sensible defaults, or null when the room has nothing it could target. */
export function newAction(model: RoomModel, type: ActionType, existing: Action[]): Action | null {
  const id = nextActionId(existing);
  const base = { id, dependsOn: [] as string[] };
  if (type === 'run_state') {
    const s = model.states[0];
    return s ? { ...base, type, stateId: s.id } : null;
  }
  if (type === 'route') {
    const src = devicesWith(model, 'video_source', 'audio_source')[0];
    const dst = devicesWith(model, 'video_sink', 'audio_sink').find((d) => d.id !== src?.id);
    return src && dst
      ? { ...base, type, sourceDeviceId: src.id, destinationDeviceId: dst.id }
      : null;
  }
  const target = actionTargets(model, type)[0];
  if (!target) return null;
  const deviceId = target.id;
  switch (type) {
    case 'power':
      return { ...base, type, deviceId, on: true };
    case 'preset':
    case 'camera_preset':
      return { ...base, type, deviceId, preset: 'default' };
    case 'mute':
      return { ...base, type, deviceId, muted: false };
    case 'volume':
      return { ...base, type, deviceId, level: model.settings.defaultVolume };
    case 'device_command':
      return { ...base, type, deviceId, command: 'command', args: {} };
    case 'env_scene':
      return { ...base, type, deviceId, scene: 'default' };
  }
}

/** Off/On states from device power capability, if the room lacks them. Returns how many were added. */
export function generateDefaultStates(model: RoomModel): number {
  let added = 0;
  const powered = devicesWith(model, 'power');
  for (const [kind, name, on] of [
    ['off', 'Off', false],
    ['on', 'On', true],
  ] as const) {
    if (model.states.some((s) => s.kind === kind)) continue;
    const state: RoomState = {
      id: uniqueId(
        kind,
        model.states.map((s) => s.id),
      ),
      name,
      kind,
      actions: powered.map((d, i) => ({
        id: `a${i + 1}`,
        type: 'power',
        deviceId: d.id,
        on,
        dependsOn: [],
      })),
    };
    model.states.push(state);
    added++;
  }
  return added;
}

/** Room-type default activities that are missing (by kind). Returns how many were added. */
export function generateDefaultActivities(model: RoomModel): number {
  let added = 0;
  const group = model.groups.find((g) => g.kind === 'display');
  for (const kind of ROOM_TYPES[model.roomType].defaultActivities) {
    if (kind === 'custom' || model.activities.some((a) => a.kind === kind)) continue;
    const def = ACTIVITY_DEFAULTS[kind];
    const activity: Activity = {
      id: uniqueId(
        kind,
        model.activities.map((a) => a.id),
      ),
      name: def.name,
      kind,
      icon: def.icon,
      hidden: false,
      requires: [...def.requires],
      sources: [],
      actions: [],
    };
    if (kind === 'present') {
      activity.sources = model.devices
        .filter((d) => d.category === 'video_source')
        .map((d) => ({ id: d.id, label: d.name, deviceId: d.id }));
      if (group) activity.targetGroupId = group.id;
      if (model.states.some((s) => s.id === 'on'))
        activity.actions = [{ id: 'a1', type: 'run_state', stateId: 'on', dependsOn: [] }];
    }
    if (kind === 'room_off' && model.states.some((s) => s.id === 'off'))
      activity.actions = [{ id: 'a1', type: 'run_state', stateId: 'off', dependsOn: [] }];
    model.activities.push(activity);
    added++;
  }
  return added;
}

export type TriggerType = Trigger['type'];

export const TRIGGER_TYPES: { type: TriggerType; label: string }[] = [
  { type: 'tap', label: 'Tap' },
  { type: 'signal_detect', label: 'Signal detected' },
  { type: 'schedule', label: 'Schedule' },
  { type: 'occupancy', label: 'Occupancy' },
  { type: 'calendar', label: 'Calendar' },
  { type: 'webhook', label: 'Webhook / API' },
];

/** New trigger running the first activity (or state), or null when there is nothing to run or no device to watch. */
export function newTrigger(model: RoomModel, type: TriggerType): Trigger | null {
  const activity = model.activities[0];
  const state = model.states[0];
  const run = activity
    ? ({ type: 'activity', activityId: activity.id } as const)
    : state
      ? ({ type: 'state', stateId: state.id } as const)
      : null;
  if (!run) return null;
  const base = {
    id: uniqueId(
      type,
      model.triggers.map((t) => t.id),
    ),
    name: TRIGGER_TYPES.find((t) => t.type === type)!.label,
    enabled: true,
    run,
  };
  const device = model.devices[0];
  switch (type) {
    case 'tap':
      return { ...base, type };
    case 'signal_detect':
      return device ? { ...base, type, deviceId: device.id } : null;
    case 'occupancy':
      return device ? { ...base, type, deviceId: device.id, occupied: false } : null;
    case 'schedule':
      return { ...base, type, cron: '0 18 * * 1-5', timezone: 'Australia/Sydney' };
    case 'calendar':
      return { ...base, type, provider: 'graph', resourceId: 'room@example.com' };
    case 'webhook':
      return {
        ...base,
        type,
        hookName: uniqueId(
          'hook',
          model.triggers.flatMap((t) => (t.type === 'webhook' ? [t.hookName] : [])),
        ),
      };
  }
}
