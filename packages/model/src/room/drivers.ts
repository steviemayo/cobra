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
