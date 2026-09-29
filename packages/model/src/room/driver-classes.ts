import { z } from 'zod';
import type { DeviceCategory } from './catalog';

// Driver classes (docs/driver-classes.md). A class is the contract for a kind of device: what a room
// can ask of it and what it reports. A vendor driver implements one class and declares the optional
// features it supports; the engine, activities and panel talk to the class, never to a vendor.

export const DriverClass = z.enum([
  'projector',
  'display',
  'video_switching',
  'avoip_switching',
  'avoip_encoder',
  'avoip_decoder',
  'point_based',
  'camera',
  'conference_system',
  'reinforcement_mic',
  'conferencing_mic',
  'recorder',
  'presentation_source',
  'environmental',
  'relay',
  'sensor',
  'infrastructure',
]);
export type DriverClass = z.infer<typeof DriverClass>;

export interface DriverClassInfo {
  label: string;
  /** Room device categories a driver of this class may be attached to. Empty: not part of a room's design. */
  categories: DeviceCategory[];
  /** Optional features a driver of this class may declare, with the words shown to people. */
  features: Record<string, string>;
}

export const DRIVER_CLASSES: Record<DriverClass, DriverClassInfo> = {
  projector: {
    label: 'Projector',
    categories: ['projector', 'video_destination'],
    features: {
      blank: 'Blank the picture (AV mute or shutter)',
      freeze: 'Freeze the picture',
      lens: 'Lens zoom, focus, shift and memories',
      light_source_hours: 'Lamp or laser hours',
      filter: 'Filter status',
      temperature: 'Temperature',
      signal_detect: 'Reports whether an input has a signal',
      builtin_audio: 'Built-in speaker volume and mute',
    },
  },
  display: {
    label: 'Display',
    categories: ['display', 'video_destination'],
    features: {
      blank: 'Blank the picture',
      signal_detect: 'Reports whether an input has a signal',
      builtin_audio: 'Built-in speaker volume and mute',
      wake: 'Wake from network standby',
      remote_keys: 'Remote keys (arrows, OK, back, home, menu)',
      media_keys: 'Media keys (play, pause, stop, forward, rewind)',
      apps: 'Lists and launches apps',
    },
  },
  video_switching: {
    label: 'Video switching (physical)',
    categories: ['video_matrix', 'audio_matrix'],
    features: {
      route: 'Routes any input to any output',
      output_mute: 'Mutes an output',
      signal_detect: 'Reports whether an input has a signal',
      auto_switch: 'Switches inputs on its own (Kestrel turns this off when it takes control)',
      edid: 'EDID management',
      audio_embed: 'Embeds or de-embeds audio',
    },
  },
  avoip_switching: {
    label: 'Video switching (AVoIP)',
    categories: ['video_matrix'],
    features: {
      route: 'Points decoders at encoder streams',
      signal_detect: 'Reports whether an encoder input has a signal',
    },
  },
  avoip_encoder: {
    label: 'AVoIP encoder',
    categories: ['avoip_encoder'],
    features: {
      stream_location: 'Reports where its stream can be picked up',
      signal_detect: 'Reports whether its input has a signal',
    },
  },
  avoip_decoder: {
    label: 'AVoIP decoder',
    categories: ['avoip_decoder'],
    features: {
      set_stream: 'Can be pointed at a stream',
      stream_state: 'Reports whether it is receiving its stream',
    },
  },
  point_based: {
    label: 'Point-based device (DSP and similar)',
    categories: ['audio_matrix', 'lighting', 'hvac', 'control_processor', 'touch_panel'],
    features: {
      level: 'Level control points',
      mute: 'Mute control points',
      select: 'Selector (router) control points',
      crosspoint: 'Crosspoint control points',
      preset: 'Preset or snapshot recall',
      meter: 'Read-only meters',
      generic: 'Generic control points',
    },
  },
  camera: {
    label: 'Camera',
    categories: ['conf_camera', 'fixed_camera', 'ptz_camera', 'autoframing_camera'],
    features: {
      preset: 'Preset recall',
      ptz: 'Pan, tilt and zoom',
      standby: 'Standby and wake',
      tracking: 'Tracking on and off',
    },
  },
  conference_system: {
    label: 'Conference system',
    categories: ['conference_system'],
    features: {
      standby: 'Standby and wake',
      mic_mute: 'Microphone mute',
      volume: 'Volume',
      dial: 'Dial a call',
      hangup: 'Hang up',
      camera_control: 'Camera control',
      content_share: 'Content sharing',
      call_state: 'Reports call state',
      registration_status: 'Reports registration',
      peripheral_health: 'Reports peripheral health',
    },
  },
  reinforcement_mic: {
    label: 'Reinforcement microphone',
    categories: ['reinforcement_mic'],
    features: {
      mute: 'Mute',
      volume: 'Volume',
      battery: 'Battery level',
      rf: 'Radio signal',
    },
  },
  conferencing_mic: {
    label: 'Conferencing microphone',
    categories: ['voice_capture_mic'],
    features: {
      privacy_mute: 'Privacy mute',
      battery: 'Battery level',
      rf: 'Radio signal',
      fault: 'Reports faults',
    },
  },
  recorder: {
    label: 'Recorder or streamer',
    categories: ['recorder'],
    features: { start_stop: 'Start and stop', pause: 'Pause', storage: 'Reports storage' },
  },
  presentation_source: {
    label: 'Presentation source',
    categories: ['video_source'],
    features: {
      standby: 'Standby and wake',
      connected: 'Reports connection',
      sharing: 'Reports sharing',
    },
  },
  environmental: {
    label: 'Environmental',
    categories: ['lighting', 'hvac', 'blinds'],
    features: { scene: 'Scene recall', zone_level: 'Zone level', setpoint: 'Temperature setpoint' },
  },
  relay: {
    label: 'Relay or mechanical',
    categories: ['screen', 'lifter', 'blinds', 'power_outlet'],
    features: {
      up_down: 'Up and down',
      stop: 'Stop',
      on_off: 'On and off',
      position: 'Reports position',
    },
  },
  sensor: {
    label: 'Sensor',
    categories: ['occupancy_sensor'],
    features: { occupancy: 'Reports occupancy', presence: 'Reports presence' },
  },
  infrastructure: {
    label: 'Infrastructure',
    categories: [],
    features: { ping: 'Reports online', snmp: 'SNMP health', http_health: 'HTTP health' },
  },
};

/** The classes a device of this category can be driven by. */
export function classesForCategory(category: DeviceCategory): DriverClass[] {
  return DriverClass.options.filter((c) => DRIVER_CLASSES[c].categories.includes(category));
}

/**
 * What a declarative driver must be able to do to belong to a class, and to declare a feature of it
 * (the class contract: docs/driver-classes.md, "every vendor driver must pass"). Command names are
 * the driver format's. A driver that claims a class or feature without them would be offered in a
 * room and then fail the first time it is used.
 */
export const CLASS_CONTRACT: Partial<
  Record<DriverClass, { commands: string[]; features: Record<string, string[]> }>
> = {
  projector: {
    commands: ['power.on', 'power.off', 'select_input'],
    features: { blank: ['blank.on', 'blank.off'], builtin_audio: ['volume'] },
  },
  display: {
    commands: ['power.on', 'power.off', 'select_input'],
    features: {
      blank: ['blank.on', 'blank.off'],
      builtin_audio: ['volume'],
      remote_keys: ['key.up', 'key.down', 'key.left', 'key.right', 'key.ok', 'key.back'],
      media_keys: ['key.play', 'key.pause', 'key.stop'],
      apps: ['app.launch'],
    },
  },
  video_switching: { commands: ['route'], features: { output_mute: ['command.output_mute'] } },
  camera: {
    commands: [],
    features: { preset: ['camera_preset'], standby: ['power.on', 'power.off'] },
  },
  conference_system: {
    commands: [],
    features: {
      standby: ['power.on', 'power.off'],
      mic_mute: ['mute.on', 'mute.off'],
      volume: ['volume'],
      hangup: ['command.hangup'],
      dial: ['command.dial'],
    },
  },
  reinforcement_mic: {
    commands: [],
    features: { mute: ['mute.on', 'mute.off'], volume: ['volume'] },
  },
  conferencing_mic: { commands: [], features: { privacy_mute: ['mute.on', 'mute.off'] } },
  recorder: { commands: [], features: { start_stop: ['record.on', 'record.off'] } },
  environmental: { commands: [], features: { scene: ['scene'] } },
  relay: {
    commands: [],
    features: { up_down: ['command.up', 'command.down'], on_off: ['power.on', 'power.off'] },
  },
};

/** Problems with a driver's declared class and features, as plain sentences. Empty when fine. */
export function classProblems(
  driverClass: DriverClass | undefined,
  features: readonly string[] | undefined,
  /** The commands the driver defines. Given, the class contract is checked too. */
  commands?: readonly string[],
): string[] {
  const problems: string[] = [];
  if (features && features.length > 0) {
    if (!driverClass) return ['Features can only be declared by a driver that names its class'];
    const known = DRIVER_CLASSES[driverClass].features;
    problems.push(
      ...[...new Set(features)]
        .filter((f) => !(f in known))
        .map(
          (f) =>
            `“${f}” is not a feature of the ${DRIVER_CLASSES[driverClass].label} class (use ${Object.keys(known).join(', ')})`,
        ),
    );
  }
  const contract = driverClass ? CLASS_CONTRACT[driverClass] : undefined;
  if (driverClass && contract && commands) {
    const have = new Set(commands);
    const label = DRIVER_CLASSES[driverClass].label;
    for (const c of contract.commands)
      if (!have.has(c)) problems.push(`A ${label} driver needs the command “${c}”`);
    for (const f of new Set(features ?? []))
      for (const c of contract.features[f] ?? [])
        if (!have.has(c)) problems.push(`The ${label} feature “${f}” needs the command “${c}”`);
  }
  return problems;
}

// ---- What a setting is for ----------------------------------------------------------------------

/**
 * design: what the room is (component names, preset names, scales). Travels with templates and releases.
 * binding: where this room's copy of the device is (address, port). Per room.
 * secret: a login or key. Sealed, write-only.
 */
export const SettingScope = z.enum(['design', 'binding', 'secret']);
export type SettingScope = z.infer<typeof SettingScope>;

const BINDING_KEYS = new Set([
  'host',
  'port',
  'address',
  'ip',
  'serial',
  'mac',
  'username',
  'user',
  'path',
]);
const SECRET_KEYS = new Set([
  'password',
  'passwd',
  'credentials',
  'token',
  'apikey',
  'secret',
  'psk',
  'pin',
  'headers',
]);

/** The scope of a setting: the one it declares, else secret for a secret type or a well-known name, binding for an address, else design. */
export function settingScope(
  key: string,
  opts: { scope?: SettingScope; type?: string } = {},
): SettingScope {
  if (opts.scope) return opts.scope;
  const k = key.toLowerCase();
  if (opts.type === 'secret' || SECRET_KEYS.has(k)) return 'secret';
  if (BINDING_KEYS.has(k)) return 'binding';
  return 'design';
}
