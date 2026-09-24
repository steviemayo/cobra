import type { DeviceCategory } from './catalog';

// The drivers that ship with Kestrel: what they are for, and settings to start from. The device
// editor offers these; the drivers themselves live in @kestrel/drivers.
export interface DriverInfo {
  name: string;
  description: string;
  categories: DeviceCategory[];
  /** A complete settings object to start from. Values in <angle brackets> must be replaced. */
  example: Record<string, unknown>;
}

export const BUILT_IN_DRIVERS: Record<string, DriverInfo> = {
  'visca-ip': {
    name: 'PTZ camera (VISCA over IP)',
    description:
      'Recalls camera presets and switches power on cameras that speak VISCA over IP. Map preset names to the camera’s preset numbers.',
    categories: ['ptz_camera', 'conf_camera', 'autoframing_camera', 'fixed_camera'],
    example: { host: '<camera IP>', presets: { Wide: 0, Podium: 1 } },
  },
  'lib:extron-sis': {
    name: 'Extron matrix switcher (SIS)',
    description: 'Extron matrix switchers over Telnet. Routing ties an input to an output.',
    categories: ['video_matrix', 'audio_matrix'],
    example: { host: '<switcher IP>' },
  },
  'lib:cisco-roomos': {
    name: 'Cisco RoomOS video conferencing',
    description: 'Cisco Room and Board devices: standby, microphone mute, volume and hang up, over the HTTP API.',
    categories: ['conference_system'],
    example: { host: '<codec IP>', credentials: '<base64 of user:password>' },
  },
  'lib:shelly-relay': {
    name: 'Shelly relay (screens and lifters)',
    description:
      'Motorised screens and lifters through a Shelly relay: command.down and command.up run for a set number of seconds.',
    categories: ['screen', 'lifter'],
    example: { host: '<relay IP>', seconds: 30 },
  },
  'lib:lutron-lip': {
    name: 'Lutron lighting (Integration Protocol)',
    description: 'Lutron processors: switch and dim a zone, press a keypad button for a scene.',
    categories: ['lighting'],
    example: { host: '<processor IP>', zone: 1, keypad: 1 },
  },
  'crestron-dm-nvx': {
    name: 'Crestron DM NVX (virtual matrix)',
    description:
      'Treats NVX encoders (inputs) and decoders (outputs) as one video matrix. Routing points a decoder at an encoder’s stream. Needs the NVX logon.',
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
