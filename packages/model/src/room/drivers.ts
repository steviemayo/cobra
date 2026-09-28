import type { DeviceCategory } from './catalog';
import type { DriverClass, SettingScope } from './driver-classes';
import type { PointForms } from './points';

// The drivers that ship with Kestrel: what they are for, and settings to start from. The device
// editor offers these; the drivers themselves live in @kestrel/drivers.
/** One setting a built-in driver reads, and what it is for (design, binding or secret). */
export interface DriverSettingInfo {
  key: string;
  label: string;
  scope: SettingScope;
  required?: boolean;
}

export interface DriverInfo {
  name: string;
  description: string;
  /** The driver class it implements, and the optional features it supports (docs/driver-classes.md). */
  class: DriverClass;
  features: string[];
  /** AVoIP: the family an encoder, decoder and switcher belong to. All three of a system must match. */
  family?: string;
  categories: DeviceCategory[];
  /** Every setting the driver reads. */
  settings: DriverSettingInfo[];
  /** For a point-based driver: the address form of each kind of control point it supports. */
  points?: PointForms;
  /** A complete settings object to start from. Values in <angle brackets> must be replaced. */
  example: Record<string, unknown>;
}

/** A Q-SYS control is a named control on a named component. */
const QSYS_CONTROL = [
  { key: 'component', label: 'Component name' },
  { key: 'control', label: 'Control name' },
];
const TESIRA_CHANNEL = [
  { key: 'tag', label: 'Instance tag' },
  { key: 'index', label: 'Channel' },
];

const NVX_ENDPOINT_SETTINGS: DriverSettingInfo[] = [
  { key: 'host', label: 'Endpoint address', scope: 'binding', required: true },
  { key: 'username', label: 'NVX logon name', scope: 'binding', required: true },
  { key: 'password', label: 'NVX password', scope: 'secret', required: true },
];

const CRESTRON_CWS_SETTINGS: DriverSettingInfo[] = [
  { key: 'host', label: 'Address', scope: 'binding', required: true },
  { key: 'username', label: 'Logon name', scope: 'binding', required: true },
  { key: 'password', label: 'Password', scope: 'secret', required: true },
];
const CRESTRON_CWS_PATH = [
  {
    key: 'path',
    label:
      'Property path (dotted, starting with "Device.", e.g. Device.Programs.ProgramInstanceLibrary.DeviceSlot1.Status)',
  },
];

const CRESTRON_FLEX_JOIN = [
  {
    key: 'join',
    label: 'Reserved join (D27767 digital, S27702 serial or A17347 analog)',
  },
];

export const BUILT_IN_DRIVERS: Record<string, DriverInfo> = {
  'visca-ip': {
    name: 'PTZ camera (VISCA over IP)',
    description:
      'Recalls camera presets and switches power on cameras that speak VISCA over IP. Map preset names to the camera’s preset numbers.',
    class: 'camera',
    features: ['preset', 'ptz', 'standby'],
    settings: [
      { key: 'host', label: 'Camera address', scope: 'binding', required: true },
      { key: 'port', label: 'Port', scope: 'binding' },
      { key: 'presets', label: 'Preset names and numbers', scope: 'design' },
      { key: 'cameraAddress', label: 'VISCA camera address', scope: 'design' },
    ],
    categories: ['ptz_camera', 'conf_camera', 'autoframing_camera', 'fixed_camera'],
    example: { host: '<camera IP>', presets: { Wide: 0, Podium: 1 } },
  },
  'biamp-tesira': {
    name: 'Biamp Tesira DSP',
    description:
      'Biamp Tesira over the Tesira Text Protocol (Telnet). Add the DSP, then add the levels, mutes and crosspoints to control as control points, each by instance tag and channel. Presets are recalled by name.',
    class: 'point_based',
    features: ['level', 'mute', 'crosspoint', 'preset'],
    settings: [
      { key: 'host', label: 'Tesira address', scope: 'binding', required: true },
      { key: 'port', label: 'Port', scope: 'binding' },
    ],
    points: {
      level: TESIRA_CHANNEL,
      mute: TESIRA_CHANNEL,
      crosspoint: [
        { key: 'tag', label: 'Instance tag' },
        { key: 'input', label: 'Input' },
        { key: 'output', label: 'Output' },
      ],
    },
    categories: ['audio_matrix'],
    example: { host: '<Tesira IP>' },
  },
  'lib:extron-sis': {
    name: 'Extron matrix switcher (SIS)',
    description: 'Extron matrix switchers over Telnet. Routing ties an input to an output.',
    class: 'video_switching',
    features: ['route'],
    settings: [{ key: 'host', label: 'Switcher address', scope: 'binding', required: true }],
    categories: ['video_matrix', 'audio_matrix'],
    example: { host: '<switcher IP>' },
  },
  'lib:cisco-roomos': {
    name: 'Cisco RoomOS video conferencing',
    description:
      'Cisco Room and Board devices: standby, microphone mute, volume and hang up, over the HTTP API.',
    class: 'conference_system',
    features: ['standby', 'mic_mute', 'volume', 'hangup'],
    settings: [
      { key: 'host', label: 'Codec address', scope: 'binding', required: true },
      {
        key: 'credentials',
        label: 'Credentials (base64 of user:password)',
        scope: 'secret',
        required: true,
      },
    ],
    categories: ['conference_system'],
    example: { host: '<codec IP>', credentials: '<base64 of user:password>' },
  },
  'lib:sony-bravia': {
    name: 'Sony BRAVIA professional display',
    description:
      'Sony BRAVIA professional displays: power, input, volume, remote keys, media keys and apps, over REST and IRCC-IP. Turn on IP control on the display and set a pre-shared key.',
    class: 'display',
    features: ['remote_keys', 'media_keys', 'apps', 'builtin_audio'],
    settings: [
      { key: 'host', label: 'Display address', scope: 'binding', required: true },
      { key: 'psk', label: 'Pre-shared key', scope: 'secret', required: true },
      { key: 'apps', label: 'Apps to offer (list of id and name)', scope: 'design' },
    ],
    categories: ['display', 'video_destination'],
    example: {
      host: '<display IP>',
      psk: '<pre-shared key>',
      apps: [{ id: '<app uri>', name: 'Netflix' }],
    },
  },
  'lib:lg-signage': {
    name: 'LG signage display',
    description:
      'LG signage and professional displays: power, HDMI 1 and 2, volume, mute and screen blank, over the network port. Turn on network control on the display.',
    class: 'display',
    features: ['blank', 'builtin_audio'],
    settings: [
      { key: 'host', label: 'Display address', scope: 'binding', required: true },
      { key: 'setId', label: 'Set ID', scope: 'binding' },
    ],
    categories: ['display', 'video_destination'],
    example: { host: '<display IP>', setId: '01' },
  },
  'lib:kramer-p3000': {
    name: 'Kramer matrix switcher (Protocol 3000)',
    description:
      'Kramer matrix switchers over Protocol 3000 (TCP 5000). Routing ties an input to an output.',
    class: 'video_switching',
    features: ['route'],
    settings: [{ key: 'host', label: 'Switcher address', scope: 'binding', required: true }],
    categories: ['video_matrix'],
    example: { host: '<switcher IP>' },
  },
  'lib:shelly-relay': {
    name: 'Shelly relay (screens and lifters)',
    description:
      'Motorised screens and lifters through a Shelly relay: command.down and command.up run for a set number of seconds.',
    class: 'relay',
    features: ['up_down', 'on_off'],
    settings: [
      { key: 'host', label: 'Relay address', scope: 'binding', required: true },
      { key: 'seconds', label: 'Run time (seconds)', scope: 'design' },
    ],
    categories: ['screen', 'lifter'],
    example: { host: '<relay IP>', seconds: 30 },
  },
  'lib:lutron-lip': {
    name: 'Lutron lighting (Integration Protocol)',
    description: 'Lutron processors: switch and dim a zone, press a keypad button for a scene.',
    class: 'environmental',
    features: ['scene', 'zone_level'],
    settings: [
      { key: 'host', label: 'Processor address', scope: 'binding', required: true },
      { key: 'zone', label: 'Zone (output) number', scope: 'design' },
      { key: 'keypad', label: 'Keypad (device) number', scope: 'design' },
    ],
    categories: ['lighting'],
    example: { host: '<processor IP>', zone: 1, keypad: 1 },
  },
  'crestron-nvx-encoder': {
    name: 'Crestron NVX encoder',
    description:
      'A Crestron NVX encoder (E30, E20 and similar) as a device in the room. Reports the location of its stream and whether its input has a signal. Needs the NVX logon.',
    class: 'avoip_encoder',
    features: ['stream_location', 'signal_detect'],
    family: 'crestron-nvx',
    settings: NVX_ENDPOINT_SETTINGS,
    categories: ['avoip_encoder'],
    example: { host: '<encoder IP>', username: 'admin', password: '<NVX password>' },
  },
  'crestron-nvx-decoder': {
    name: 'Crestron NVX decoder',
    description:
      'A Crestron NVX decoder (D30, DM-NVX-351 and similar) as a device in the room. Pointed at an encoder stream by its switcher. Needs the NVX logon.',
    class: 'avoip_decoder',
    features: ['set_stream', 'stream_state'],
    family: 'crestron-nvx',
    settings: NVX_ENDPOINT_SETTINGS,
    categories: ['avoip_decoder'],
    example: { host: '<decoder IP>', username: 'admin', password: '<NVX password>' },
  },
  'crestron-nvx-switcher': {
    name: 'Crestron NVX virtual switcher',
    description:
      'The routing logic for NVX encoders and decoders that are devices in the room. It has no address of its own: routing reads the encoder stream, points the decoder at it and waits until the decoder is receiving.',
    class: 'avoip_switching',
    features: ['route', 'signal_detect'],
    family: 'crestron-nvx',
    settings: [],
    categories: ['video_matrix'],
    example: {},
  },
  'crestron-dm-nvx': {
    name: 'Crestron DM NVX (virtual matrix)',
    description:
      'Treats NVX encoders (inputs) and decoders (outputs) as one video matrix. Routing points a decoder at an encoder’s stream. Needs the NVX logon.',
    class: 'avoip_switching',
    features: ['route', 'signal_detect'],
    settings: [
      { key: 'username', label: 'NVX logon name', scope: 'binding', required: true },
      { key: 'password', label: 'NVX password', scope: 'secret', required: true },
      {
        key: 'inputs',
        label: 'Encoders (input port to address)',
        scope: 'binding',
        required: true,
      },
      {
        key: 'outputs',
        label: 'Decoders (output port to address)',
        scope: 'binding',
        required: true,
      },
    ],
    categories: ['video_matrix'],
    example: {
      username: 'admin',
      password: '<NVX password>',
      inputs: { in1: { host: '<encoder IP>' } },
      outputs: { out1: { host: '<decoder IP>' } },
    },
  },
  'qsys-core': {
    name: 'Q-SYS Core (gain component)',
    description:
      'Volume and mute through a gain component on a Q-SYS Core, over QRC. 0-100 on the panel maps to minDb..maxDb. Routing is part of the Q-SYS design.',
    class: 'point_based',
    features: ['level', 'mute', 'preset'],
    settings: [
      { key: 'host', label: 'Core address', scope: 'binding', required: true },
      { key: 'username', label: 'Logon name (if the Core needs one)', scope: 'binding' },
      { key: 'password', label: 'Password (if the Core needs one)', scope: 'secret' },
      { key: 'gainComponent', label: 'Gain component name', scope: 'design', required: true },
      { key: 'gainControl', label: 'Gain control name', scope: 'design' },
      { key: 'muteControl', label: 'Mute control name', scope: 'design' },
      { key: 'minDb', label: 'Level at 0 on the panel (dB)', scope: 'design' },
      { key: 'maxDb', label: 'Level at 100 on the panel (dB)', scope: 'design' },
    ],
    points: {
      level: QSYS_CONTROL,
      mute: QSYS_CONTROL,
      select: QSYS_CONTROL,
      meter: QSYS_CONTROL,
      generic: QSYS_CONTROL,
    },
    categories: ['audio_matrix'],
    example: {
      host: '<Core IP>',
      gainComponent: 'gain',
      gainControl: 'gain',
      muteControl: 'mute',
      minDb: -40,
      maxDb: 0,
    },
  },
  'crestron-4series': {
    name: 'Crestron 4-series control processor',
    description:
      'Monitoring only, over the same CresNext REST API as DM-NVX: reports firmware, and any control point named by a dotted path into the unit’s /Device tree. Most useful for a program slot’s own status, or one of its IP table entries (ONLINE/OFFLINE) — the processor’s own view of whether it can reach a device on the network.',
    class: 'point_based',
    features: ['generic'],
    settings: CRESTRON_CWS_SETTINGS,
    points: { generic: CRESTRON_CWS_PATH },
    categories: ['control_processor'],
    example: {
      host: '<processor IP>',
      username: 'admin',
      password: '<password>',
    },
  },
  'crestron-tsw': {
    name: 'Crestron TSW / TS touch panel',
    description:
      'Monitoring only: the panel keeps running its own Crestron program and UI. Reports firmware, the screen’s awake/asleep state and the running app, over the same CresNext REST API as DM-NVX. Any other field (proximity, Bluetooth, ...) is available as a control point named by a dotted path into the panel’s /Device tree.',
    class: 'point_based',
    features: ['generic'],
    settings: CRESTRON_CWS_SETTINGS,
    points: { generic: CRESTRON_CWS_PATH },
    categories: ['touch_panel'],
    example: {
      host: '<panel IP>',
      username: 'admin',
      password: '<password>',
    },
  },
  'crestron-flex': {
    name: 'Crestron Flex (Microsoft Teams Room)',
    description:
      'Monitoring only. Logs in to the UC-Engine’s secure console and reads the Teams Rooms app’s reserved joins: app state, Teams and Exchange sign-in, microphone, speaker, camera and display health, and the room’s occupancy. Watch any reserved join as a control point to alert on it, for example the microphone status (S27702) expecting Healthy.',
    class: 'conference_system',
    features: ['call_state', 'peripheral_health'],
    settings: [
      { key: 'host', label: 'Address', scope: 'binding', required: true },
      { key: 'username', label: 'Logon name (admin)', scope: 'binding', required: true },
      { key: 'password', label: 'Password', scope: 'secret', required: true },
      { key: 'port', label: 'Secure console port (41797)', scope: 'binding' },
    ],
    points: { generic: CRESTRON_FLEX_JOIN },
    categories: ['conference_system'],
    example: { host: '<UC-Engine IP>', username: 'admin', password: '<password>' },
  },
  'crestron-occupancy': {
    name: 'Crestron occupancy sensor',
    description:
      'Monitoring only, over the CresNext REST API: reports whether the room is occupied, kept up to date with a long poll, and lists what the sensor says about itself. Not yet checked against a real sensor.',
    class: 'sensor',
    features: ['occupancy'],
    settings: [
      ...CRESTRON_CWS_SETTINGS,
      {
        key: 'occupiedPath',
        label: 'Occupied property path (only if not found automatically)',
        scope: 'design',
      },
    ],
    categories: ['occupancy_sensor'],
    example: { host: '<sensor IP>', username: 'admin', password: '<password>' },
  },
};
