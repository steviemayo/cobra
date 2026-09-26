import type { DeviceCategory } from './catalog';
import type { DriverClass, SettingScope } from './driver-classes';

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
  categories: DeviceCategory[];
  /** Every setting the driver reads. */
  settings: DriverSettingInfo[];
  /** A complete settings object to start from. Values in <angle brackets> must be replaced. */
  example: Record<string, unknown>;
}

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
    description: 'Cisco Room and Board devices: standby, microphone mute, volume and hang up, over the HTTP API.',
    class: 'conference_system',
    features: ['standby', 'mic_mute', 'volume', 'hangup'],
    settings: [
      { key: 'host', label: 'Codec address', scope: 'binding', required: true },
      { key: 'credentials', label: 'Credentials (base64 of user:password)', scope: 'secret', required: true },
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
    example: { host: '<display IP>', psk: '<pre-shared key>', apps: [{ id: '<app uri>', name: 'Netflix' }] },
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
  'crestron-dm-nvx': {
    name: 'Crestron DM NVX (virtual matrix)',
    description:
      'Treats NVX encoders (inputs) and decoders (outputs) as one video matrix. Routing points a decoder at an encoder’s stream. Needs the NVX logon.',
    class: 'avoip_switching',
    features: ['route', 'signal_detect'],
    settings: [
      { key: 'username', label: 'NVX logon name', scope: 'binding', required: true },
      { key: 'password', label: 'NVX password', scope: 'secret', required: true },
      { key: 'inputs', label: 'Encoders (input port to address)', scope: 'binding', required: true },
      { key: 'outputs', label: 'Decoders (output port to address)', scope: 'binding', required: true },
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
};
