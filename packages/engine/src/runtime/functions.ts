import { MEDIA_KEYS, NAVIGATION_KEYS, type DeviceBus, type Device, type DisplayKey, type MoverAction, type PanelFunctions, type RoomModel } from '@kestrel/model';

// The pages behind the panel's top nav: cameras, microphones, lighting and blinds/screens. A page
// is offered only when the room enables it (Extra controls in the room's settings) and has
// equipment with a driver that can do it, so a room never shows a control that cannot work.

export interface FunctionSets {
  cameras: { device: Device; presets: string[] }[];
  /** Reinforcement microphones a person can control, in the order the panel shows them. */
  microphones: { device: Device; label: string }[];
  lights: { device: Device; scenes: string[] }[];
  movers: { device: Device; kind: 'blinds' | 'screen' | 'lifter'; actions: MoverAction[] }[];
  /** Smart displays. What each offers depends on its driver, which only the bus knows. */
  displays: { device: Device; apps: { id: string; name: string }[] }[];
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

/** The apps a dev listed for a display: `settings.apps` as `{ id, name }` entries. */
function appsIn(value: unknown): { id: string; name: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { id: string; name: string }[] = [];
  for (const v of value) {
    const id = v && typeof v === 'object' ? (v as { id?: unknown }).id : undefined;
    const name = v && typeof v === 'object' ? (v as { name?: unknown }).name : undefined;
    if (typeof id === 'string' && id && !out.some((o) => o.id === id))
      out.push({ id, name: typeof name === 'string' && name.trim() ? name.trim() : id });
  }
  return out.slice(0, 24);
}

/** Which keys a display's driver lets people press, from the features it declares. */
export function keysFor(features: string[]): { keys: boolean; media: boolean } {
  return { keys: features.includes('remote_keys'), media: features.includes('media_keys') };
}

export const isNavigationKey = (k: DisplayKey) => NAVIGATION_KEYS.includes(k);
export const isMediaKey = (k: DisplayKey) => MEDIA_KEYS.includes(k);

const unique = (names: string[]) =>
  [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, 24);

export function functionSets(model: RoomModel): FunctionSets {
  const { userControls } = model.settings;
  const driven = (d: Device) => !!d.control;
  const sets: FunctionSets = { cameras: [], microphones: [], lights: [], movers: [], displays: [] };

  if (userControls.display)
    for (const d of model.devices)
      if ((d.category === 'display' || d.category === 'video_destination') && driven(d))
        sets.displays.push({ device: d, apps: appsIn(d.settings.apps) });

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

  // Only reinforcement microphones: people hear through them, so they are theirs to mute and turn
  // up. Conferencing microphones have a fixed level and only take part in Privacy Mute.
  if (userControls.microphones)
    sets.microphones = model.devices
      .filter((d) => d.category === 'reinforcement_mic' && driven(d) && !d.mic?.hidden)
      .map((device, index) => ({ device, label: device.mic?.label ?? device.name, index }))
      .sort((a, b) => (a.device.mic?.order ?? 1000) - (b.device.mic?.order ?? 1000) || a.index - b.index)
      .map(({ device, label }) => ({ device, label }));

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
    microphones: sets.microphones.map(({ device, label }) => {
      const state = bus.getState(device.id);
      const canVolume = (bus.features?.(device.id) ?? []).includes('volume');
      return {
        id: device.id,
        name: label,
        muted: state?.muted ?? null,
        canVolume,
        volume: canVolume ? (state?.volume ?? null) : null,
      };
    }),
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
    displays: [],
  };
  view.displays = sets.displays.flatMap(({ device, apps }) => {
    const features = bus.features?.(device.id) ?? [];
    const { keys, media } = keysFor(features);
    const offered = features.includes('apps') ? apps : [];
    if (!keys && !media && offered.length === 0) return [];
    return [
      {
        id: device.id,
        name: device.name,
        keys,
        media,
        apps: offered,
        activeApp: bus.getState(device.id)?.activeApp ?? null,
      },
    ];
  });
  const any =
    view.cameras.length +
    view.microphones.length +
    view.lights.length +
    view.movers.length +
    view.displays.length;
  return any > 0 ? view : undefined;
}
