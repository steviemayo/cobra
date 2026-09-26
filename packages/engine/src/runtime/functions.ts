import type { DeviceBus, Device, MoverAction, PanelFunctions, RoomModel } from '@kestrel/model';

// The pages behind the panel's top nav: cameras, microphones, lighting and blinds/screens. A page
// is offered only when the room enables it (Extra controls in the room's settings) and has
// equipment with a driver that can do it, so a room never shows a control that cannot work.

export interface FunctionSets {
  cameras: { device: Device; presets: string[] }[];
  microphones: Device[];
  lights: { device: Device; scenes: string[] }[];
  movers: { device: Device; kind: 'blinds' | 'screen' | 'lifter'; actions: MoverAction[] }[];
}

const MOVER_ACTIONS: Record<'blinds' | 'screen' | 'lifter', MoverAction[]> = {
  blinds: ['open', 'close'],
  screen: ['down', 'up'],
  lifter: ['down', 'up'],
};

/** Names from a device setting that is either a list of names or an object keyed by name. */
function namesIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (value && typeof value === 'object') return Object.keys(value);
  return [];
}

/** Names the room's own activities and states already use for a device, so they can be recalled too. */
function usedNames(
  model: RoomModel,
  deviceId: string,
  type: 'camera_preset' | 'env_scene',
): string[] {
  const actions = [
    ...model.activities.flatMap((a) => a.actions),
    ...model.states.flatMap((s) => s.actions),
  ];
  return actions.flatMap((a) => {
    if (a.type !== type || a.deviceId !== deviceId) return [];
    return [
      type === 'camera_preset' ? (a as { preset: string }).preset : (a as { scene: string }).scene,
    ];
  });
}

const unique = (names: string[]) =>
  [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, 24);

export function functionSets(model: RoomModel): FunctionSets {
  const { userControls } = model.settings;
  const driven = (d: Device) => !!d.control;
  const sets: FunctionSets = { cameras: [], microphones: [], lights: [], movers: [] };

  if (userControls.camera)
    for (const d of model.devices) {
      if ((d.category !== 'ptz_camera' && d.category !== 'autoframing_camera') || !driven(d))
        continue;
      sets.cameras.push({
        device: d,
        presets: unique([
          ...namesIn(d.settings.presets),
          ...usedNames(model, d.id, 'camera_preset'),
        ]),
      });
    }

  if (userControls.microphones)
    for (const d of model.devices)
      if ((d.category === 'reinforcement_mic' || d.category === 'voice_capture_mic') && driven(d))
        sets.microphones.push(d);

  if (userControls.lights)
    for (const d of model.devices) {
      if (d.category !== 'lighting' || !driven(d)) continue;
      const scenes = unique([
        ...namesIn(d.settings.scenes),
        ...usedNames(model, d.id, 'env_scene'),
      ]);
      if (scenes.length > 0) sets.lights.push({ device: d, scenes });
    }

  if (userControls.blinds)
    for (const d of model.devices) {
      if (!driven(d)) continue;
      const kind =
        d.category === 'blinds'
          ? 'blinds'
          : d.category === 'screen'
            ? 'screen'
            : d.category === 'lifter'
              ? 'lifter'
              : null;
      if (kind) sets.movers.push({ device: d, kind, actions: MOVER_ACTIONS[kind] });
    }
  return sets;
}

/** What the panel shows, with each device's current state. Undefined when the room offers no pages. */
export function functionsView(sets: FunctionSets, bus: DeviceBus): PanelFunctions | undefined {
  const view: PanelFunctions = {
    cameras: sets.cameras.map(({ device, presets }) => ({
      id: device.id,
      name: device.name,
      presets,
      activePreset: bus.getState(device.id)?.preset ?? null,
      canMove: true,
    })),
    microphones: sets.microphones.map((d) => ({
      id: d.id,
      name: d.name,
      muted: bus.getState(d.id)?.muted ?? null,
    })),
    lights: sets.lights.map(({ device, scenes }) => ({
      id: device.id,
      name: device.name,
      scenes,
      active: bus.getState(device.id)?.preset ?? null,
    })),
    movers: sets.movers.map(({ device, kind, actions }) => ({
      id: device.id,
      name: device.name,
      kind,
      actions,
    })),
  };
  const any =
    view.cameras.length + view.microphones.length + view.lights.length + view.movers.length;
  return any > 0 ? view : undefined;
}
