import type { AssetCategory } from '../devices';
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

/** The device types the driver picker groups by. */
export const DRIVER_GROUPS = {
  display: 'Display and projector',
  matrix: 'Video matrix and AVoIP',
  audio: 'Audio and music',
  conference: 'Conference system',
  camera: 'Camera',
  control: 'Control and panels',
  sensor: 'Sensors',
  environment: 'Environment and power',
  network: 'Network and IT',
  generic: 'Generic',
} as const;
export type DriverGroup = keyof typeof DRIVER_GROUPS;

export interface DriverInfo {
  name: string;
  /** How the picker shows it: `Category – Make Model` (or `Make Series`). */
  label: string;
  group: DriverGroup;
  /** Kept so existing devices load, but not offered for new ones. */
  hidden?: boolean;
  /** What the driver implies about the box when the device itself reports nothing more specific. */
  make?: string;
  model?: string;
  description: string;
  /** The driver class it implements, and the optional features it supports (docs/driver-classes.md). */
  class: DriverClass;
  features: string[];
  /** AVoIP: the family an encoder, decoder and switcher belong to. All three of a system must match. */
  family?: string;
  categories: AssetCategory[];
  /** Every setting the driver reads. */
  settings: DriverSettingInfo[];
  /** For a point-based driver: the address form of each kind of control point it supports. */
  points?: PointForms;
  /** The driver can list the values inside the live device, so a point is picked rather than typed. */
  browse?: boolean;
  /** A complete settings object to start from. Values in <angle brackets> must be replaced. */
  example: Record<string, unknown>;
}

/** A Q-SYS control is a named control on a named component. */
const QSYS_CONTROL = [
  { key: 'component', label: 'Component name' },
  { key: 'control', label: 'Control name' },
];
/** A named control stands alone; a named component's control is addressed by both. */
const QSYS_NAMED = [
  { key: 'component', label: 'Component name (blank for a named control)', optional: true },
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
    label: 'Camera – Generic VISCA over IP',
    group: 'camera',
    description:
      'Recalls camera presets, points the camera and switches power on cameras that speak VISCA over IP. Map preset names to the camera’s preset numbers. Over UDP it uses the 8 byte VISCA over IP header (port 52381). For a camera that takes plain VISCA over TCP, such as the Crestron 1 Beyond, set Transport to tcp (raw framing, port 5678 unless you set it).',
    class: 'camera',
    features: ['preset', 'ptz', 'standby'],
    settings: [
      { key: 'host', label: 'Camera address', scope: 'binding', required: true },
      { key: 'port', label: 'Port', scope: 'binding' },
      { key: 'transport', label: 'Transport (udp or tcp, default udp)', scope: 'binding' },
      {
        key: 'framing',
        label: 'Framing (ip = 8 byte header, raw = plain VISCA; default ip for udp, raw for tcp)',
        scope: 'binding',
      },
      { key: 'presets', label: 'Preset names and numbers', scope: 'design' },
      { key: 'cameraAddress', label: 'VISCA camera address', scope: 'design' },
    ],
    categories: ['ptz_camera', 'conf_camera', 'autoframing_camera', 'fixed_camera'],
    example: { host: '<camera IP>', presets: { Wide: 0, Podium: 1 } },
  },
  onvif: {
    name: 'IP camera (ONVIF)',
    label: 'Camera – Generic ONVIF (Profile S)',
    group: 'camera',
    make: 'Generic',
    description:
      'IP cameras that speak ONVIF Profile S (Axis, Panasonic, Sony, Hikvision, Dahua, Bosch, Hanwha and many others): whether it answers, its manufacturer, model, serial number and firmware, its saved presets, pointing it, and a JPEG snapshot on request that is shown once and not kept. Turn on ONVIF on the camera and create an ONVIF user. Not yet checked against a real camera.',
    class: 'camera',
    features: ['preset', 'ptz', 'snapshot'],
    settings: [
      { key: 'host', label: 'Camera address', scope: 'binding', required: true },
      { key: 'port', label: 'Port (80, or 443 with https)', scope: 'binding' },
      { key: 'https', label: 'Use https (true or false)', scope: 'design' },
      { key: 'username', label: 'ONVIF user', scope: 'binding', required: true },
      { key: 'password', label: 'ONVIF password', scope: 'secret', required: true },
      { key: 'profile', label: 'Media profile token (the first one when blank)', scope: 'design' },
      { key: 'speed', label: 'Pan and tilt speed (0.1 to 1, 0.5)', scope: 'design' },
    ],
    categories: ['ptz_camera', 'fixed_camera', 'conf_camera', 'autoframing_camera'],
    example: { host: '<camera IP>', username: '<ONVIF user>', password: '<ONVIF password>' },
  },
  'biamp-tesira': {
    name: 'Biamp Tesira DSP',
    label: 'Audio DSP – Biamp Tesira',
    group: 'audio',
    make: 'Biamp',
    model: 'Tesira DSP',
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
    label: 'Matrix – Extron SIS series',
    group: 'matrix',
    make: 'Extron',
    description: 'Extron matrix switchers over Telnet. Routing ties an input to an output.',
    class: 'video_switching',
    features: ['route'],
    settings: [{ key: 'host', label: 'Switcher address', scope: 'binding', required: true }],
    categories: ['video_matrix', 'audio_matrix'],
    example: { host: '<switcher IP>' },
  },
  'lib:cisco-roomos': {
    name: 'Cisco RoomOS video conferencing',
    label: 'Conference – Cisco RoomOS series',
    group: 'conference',
    make: 'Cisco',
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
    label: 'Display – Sony BRAVIA series',
    group: 'display',
    make: 'Sony',
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
    label: 'Display – LG Signage series',
    group: 'display',
    make: 'LG',
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
    label: 'Matrix – Kramer P3000 series',
    group: 'matrix',
    make: 'Kramer',
    description:
      'Kramer matrix switchers over Protocol 3000 (TCP 5000). Routing ties an input to an output.',
    class: 'video_switching',
    features: ['route'],
    settings: [{ key: 'host', label: 'Switcher address', scope: 'binding', required: true }],
    categories: ['video_matrix'],
    example: { host: '<switcher IP>' },
  },
  'lib:samsung-mdc': {
    name: 'Samsung MDC display',
    label: 'Display – Samsung MDC series',
    group: 'display',
    make: 'Samsung',
    description:
      'Samsung commercial displays (QM, QB, QH, OM and similar) over MDC on TCP 1515: power, input (HDMI 1 to 3 and DisplayPort), volume and mute. Turn on MDC over the network in the display menu. Not yet checked against a real display.',
    class: 'display',
    features: ['builtin_audio'],
    settings: [
      { key: 'host', label: 'Display address', scope: 'binding', required: true },
      { key: 'displayId', label: 'Display ID (hex, FE for any)', scope: 'binding' },
    ],
    categories: ['display', 'video_destination'],
    example: { host: '<display IP>', displayId: 'FE' },
  },
  'lib:philips-sicp': {
    name: 'Philips SICP display',
    label: 'Display – Philips SICP series',
    group: 'display',
    make: 'Philips',
    description:
      'Philips professional displays (BDL series and similar) over SICP on TCP 5000: power, input (HDMI 1 to 4, DisplayPort, DVI-D) and volume. There is no mute command. Not yet checked against a real display.',
    class: 'display',
    features: ['builtin_audio'],
    settings: [
      { key: 'host', label: 'Display address', scope: 'binding', required: true },
      { key: 'monitorId', label: 'Monitor ID (hex)', scope: 'binding' },
    ],
    categories: ['display', 'video_destination'],
    example: { host: '<display IP>', monitorId: '01' },
  },
  'lib:sharp-nec': {
    name: 'Sharp NEC display',
    label: 'Display – Sharp NEC series',
    group: 'display',
    make: 'Sharp NEC',
    description:
      'Sharp NEC large format displays (MultiSync and Sharp-branded NEC panels) over external control on TCP 7142: power, input (HDMI 1, HDMI 2, DisplayPort 1) and volume. There is no mute command. Not yet checked against a real display.',
    class: 'display',
    features: ['builtin_audio'],
    settings: [
      { key: 'host', label: 'Display address', scope: 'binding', required: true },
      { key: 'monitorId', label: 'Monitor ID (hex ASCII letter, 41 = ID 1)', scope: 'binding' },
    ],
    categories: ['display', 'video_destination'],
    example: { host: '<display IP>', monitorId: '41' },
  },
  'lib:shure-mxa': {
    name: 'Shure MXA microphone',
    label: 'Microphone – Shure MXA series',
    group: 'audio',
    make: 'Shure',
    description:
      'Shure Microflex Advance microphones (MXA901, MXA902, MXA925, MXA710, MXA320 and the same family) over command strings on TCP 2202: mute state and control, identify, and the model, serial number and firmware. Not yet checked against a real microphone.',
    class: 'conferencing_mic',
    features: ['privacy_mute'],
    settings: [{ key: 'host', label: 'Microphone address', scope: 'binding', required: true }],
    categories: ['voice_capture_mic'],
    example: { host: '<microphone IP>' },
  },
  'lib:sennheiser-tcc2': {
    name: 'Sennheiser TeamConnect Ceiling 2',
    label: 'Microphone – Sennheiser TeamConnect Ceiling 2',
    group: 'audio',
    make: 'Sennheiser',
    model: 'TeamConnect Ceiling 2',
    description:
      'Sennheiser TeamConnect Ceiling 2 over the Sennheiser Sound Control protocol on UDP 45: mute state and control, and the product, serial number and firmware version. Not yet checked against a real unit.',
    class: 'conferencing_mic',
    features: ['privacy_mute'],
    settings: [{ key: 'host', label: 'Microphone address', scope: 'binding', required: true }],
    categories: ['voice_capture_mic'],
    example: { host: '<microphone IP>' },
  },
  'lib:sennheiser-tcc-medium': {
    name: 'Sennheiser TeamConnect Ceiling Medium',
    label: 'Microphone – Sennheiser TeamConnect Ceiling Medium',
    group: 'audio',
    make: 'Sennheiser',
    model: 'TeamConnect Ceiling Medium',
    description:
      'Sennheiser TeamConnect Ceiling Medium over SSCv2 (HTTPS). Monitoring only for now: whether it answers, its product name and serial number. Enable third party access and set a password in Sennheiser Control Cockpit first. Not yet checked against a real unit.',
    class: 'conferencing_mic',
    features: [],
    settings: [
      { key: 'host', label: 'Microphone address', scope: 'binding', required: true },
      { key: 'credentials', label: 'Credentials (base64 of api:password)', scope: 'secret', required: true },
    ],
    categories: ['voice_capture_mic'],
    example: { host: '<microphone IP>', credentials: '<base64 of api:password>' },
  },
  'lib:sennheiser-tc-bar': {
    name: 'Sennheiser TeamConnect Bar',
    label: 'Microphone – Sennheiser TeamConnect Bar S and M',
    group: 'audio',
    make: 'Sennheiser',
    description:
      'Sennheiser TeamConnect Bar S and M over SSCv2 (HTTPS). Monitoring only for now: whether it answers, its product name and serial number. Enable third party access and set a password in Sennheiser Control Cockpit first. Not yet checked against a real unit.',
    class: 'conference_system',
    features: [],
    settings: [
      { key: 'host', label: 'Bar address', scope: 'binding', required: true },
      { key: 'credentials', label: 'Credentials (base64 of api:password)', scope: 'secret', required: true },
    ],
    categories: ['conference_system', 'voice_capture_mic'],
    example: { host: '<bar IP>', credentials: '<base64 of api:password>' },
  },
  'lib:shelly-relay': {
    name: 'Shelly relay (screens and lifters)',
    label: 'Relay – Shelly (screens and lifters)',
    group: 'environment',
    make: 'Shelly',
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
  'lib:blustream-pwr8iec': {
    name: 'Blustream PWR8IEC power controller',
    label: 'Power – Blustream PWR8IEC (basic)',
    group: 'environment',
    hidden: true,
    make: 'Blustream',
    model: 'PWR8IEC',
    description:
      'Blustream PWR8IEC / PWR4IEC / PWR2IEC IEC power controllers, over Telnet. Switch every outlet at once, or add a command action for one outlet (command.outlet1_on, command.outlet1_off, up to outlet8) for whichever the physical unit has.',
    class: 'relay',
    features: ['on_off'],
    settings: [{ key: 'host', label: 'Controller address', scope: 'binding', required: true }],
    categories: ['power_outlet'],
    example: { host: '<controller IP>' },
  },
  'lib:lutron-lip': {
    name: 'Lutron lighting (Integration Protocol)',
    label: 'Lighting – Lutron LIP series',
    group: 'environment',
    make: 'Lutron',
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
    label: 'AVoIP encoder – Crestron NVX',
    group: 'matrix',
    make: 'Crestron',
    model: 'DM NVX encoder',
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
    label: 'AVoIP decoder – Crestron NVX',
    group: 'matrix',
    make: 'Crestron',
    model: 'DM NVX decoder',
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
    label: 'AVoIP matrix – Crestron NVX (virtual switcher)',
    group: 'matrix',
    make: 'Crestron',
    model: 'DM NVX virtual switcher',
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
    label: 'AVoIP matrix – Crestron DM NVX (virtual matrix)',
    group: 'matrix',
    make: 'Crestron',
    model: 'DM NVX virtual matrix',
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
    name: 'Q-SYS Core',
    label: 'Audio DSP – QSC Q-SYS Core',
    group: 'audio',
    make: 'QSC',
    model: 'Q-SYS Core',
    description:
      'A Q-SYS Core over QRC (port 1710). The driver keeps the connection and reports whether the Core answers and its engine status. Then add the control points to watch: named components (gain: gain and mute; router: select.1 to select.n) and named controls (on or off, a whole number, or text). They are read through a change group, so only what changes is sent. Routing is part of the Q-SYS design.',
    class: 'point_based',
    features: ['level', 'mute', 'preset'],
    settings: [
      { key: 'host', label: 'Core address', scope: 'binding', required: true },
      { key: 'username', label: 'Logon name (if the Core needs one)', scope: 'binding' },
      { key: 'password', label: 'Password (if the Core needs one)', scope: 'secret' },
      {
        key: 'restPort',
        label: 'Web port for the model, serial number and firmware (443)',
        scope: 'design',
      },
      { key: 'restProtocol', label: 'https or http for that web port', scope: 'design' },
      {
        key: 'allowSelfSigned',
        label: 'Accept the Core’s own certificate (true)',
        scope: 'design',
      },
      {
        key: 'gainComponent',
        label: 'Gain component name (older room designs only)',
        scope: 'design',
      },
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
      generic: QSYS_NAMED,
    },
    categories: ['audio_matrix'],
    example: {
      host: '<Core IP>',
    },
  },
  'crestron-4series': {
    name: 'Crestron 4-series control processor',
    label: 'Control processor – Crestron 4-Series',
    group: 'control',
    make: 'Crestron',
    model: '4-Series control processor',
    description:
      'Monitoring only, over the same CresNext REST API as DM-NVX: reports firmware, and any control point named by a dotted path into the unit’s /Device tree. Most useful for a program slot’s own status, or one of its IP table entries (ONLINE/OFFLINE) — the processor’s own view of whether it can reach a device on the network.',
    class: 'point_based',
    features: ['generic'],
    settings: CRESTRON_CWS_SETTINGS,
    points: { generic: CRESTRON_CWS_PATH },
    browse: true,
    categories: ['control_processor'],
    example: {
      host: '<processor IP>',
      username: 'admin',
      password: '<password>',
    },
  },
  'crestron-tsw': {
    name: 'Crestron TSW / TS touch panel',
    label: 'Touch panel – Crestron 70 Series Touch',
    group: 'control',
    make: 'Crestron',
    model: 'TSW touch panel',
    description:
      'Monitoring only: the panel keeps running its own Crestron program and UI. Reports firmware, the screen’s awake/asleep state and the running app, over the same CresNext REST API as DM-NVX. Any other field (proximity, Bluetooth, ...) is available as a control point named by a dotted path into the panel’s /Device tree.',
    class: 'point_based',
    features: ['generic'],
    settings: CRESTRON_CWS_SETTINGS,
    points: { generic: CRESTRON_CWS_PATH },
    browse: true,
    categories: ['touch_panel'],
    example: {
      host: '<panel IP>',
      username: 'admin',
      password: '<password>',
    },
  },
  'crestron-flex': {
    name: 'Crestron Flex (Microsoft Teams Room)',
    label: 'Conference – Crestron Flex (Teams Room)',
    group: 'conference',
    make: 'Crestron',
    model: 'Flex Teams Room',
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
  'blustream-acm1000': {
    name: 'Blustream ACM1000 virtual AVoIP matrix',
    label: 'AVoIP matrix – Blustream ACM1000',
    group: 'matrix',
    make: 'Blustream',
    model: 'ACM1000',
    description:
      'A Blustream ACM1000 AVoIP matrix, controlled as one box: the commissioner’s own scan/assign step wires up the encoders and decoders on the ACM1000 itself, so Kestrel only routes on the ACM1000 and never touches the endpoints. Reports how many inputs and outputs it has seen. Not yet verified against real hardware.',
    class: 'avoip_switching',
    features: ['route'],
    settings: [
      { key: 'host', label: 'ACM1000 address', scope: 'binding', required: true },
      { key: 'pollMs', label: 'How often to refresh the port list (ms)', scope: 'design' },
    ],
    categories: ['video_matrix'],
    example: { host: '<ACM1000 IP>' },
  },
  'blustream-da11abl': {
    name: 'Blustream DA11ABL-WP-V2 Bluetooth wall plate',
    label: 'Audio – Blustream DA11ABL-WP-V2 (Bluetooth wall plate)',
    group: 'audio',
    make: 'Blustream',
    model: 'DA11ABL-WP-V2',
    description:
      'A Bluetooth and analogue audio wall plate. Routes the room’s output from its analogue input or a paired phone (route port "in1" is analogue, "in2" is Bluetooth), and reports Bluetooth connection status and the paired device’s name. Not yet verified against real hardware.',
    class: 'video_switching',
    features: ['route'],
    settings: [
      { key: 'host', label: 'Wall plate address', scope: 'binding', required: true },
      { key: 'pollMs', label: 'How often to check Bluetooth status (ms)', scope: 'design' },
    ],
    categories: ['audio_matrix'],
    example: { host: '<wall plate IP>' },
  },
  'crestron-occupancy': {
    name: 'Crestron occupancy sensor',
    label: 'Sensor – Crestron CEN-ODT-C-POE',
    group: 'sensor',
    make: 'Crestron',
    model: 'Occupancy sensor',
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
  'blustream-pwr': {
    name: 'Blustream IEC power controller (PWR2/4/8IEC)',
    label: 'Power – Blustream PWR IEC series (2/4/8)',
    group: 'environment',
    make: 'Blustream',
    model: 'PWR IEC power controller',
    description:
      'Blustream PWR2IEC, PWR4IEC and PWR8IEC power controllers over the Telnet console. Switches every outlet or one outlet, and reads back each outlet’s state, whether something is connected to it, and its current, power and energy use, plus the unit’s firmware, address and system status. Each outlet can be watched as a control point, so one controller shared by several rooms gives each room its own outlets. Checked against a real PWR4IEC; the other two sizes are expected to answer the same way.',
    class: 'relay',
    features: ['on_off'],
    settings: [
      { key: 'host', label: 'Controller address', scope: 'binding', required: true },
      { key: 'port', label: 'Port (23)', scope: 'binding' },
      { key: 'pollMs', label: 'How often to read the controller (ms)', scope: 'design' },
    ],
    points: {
      generic: [
        { key: 'outlet', label: 'Outlet number' },
        { key: 'field', label: 'Reading: state, load, amps, watts, kwh or volts' },
      ],
    },
    categories: ['power_outlet'],
    example: { host: '<controller IP>' },
  },
  'netgear-av': {
    name: 'Netgear AV switch',
    label: 'Network – Netgear AV series (M4250 / M4300)',
    group: 'network',
    make: 'Netgear',
    description:
      'Netgear AV line managed switches (M4250, M4300 and their PoE variants) over the switch\'s own web API, with nothing to turn on: model, serial number, firmware and uptime, temperature, fans, CPU and memory, which ports are up and at what speed, PoE budget and use, and the power each PoE port is drawing. A PoE port can be power-cycled (command poe_cycle_<port>) to reboot what it powers. Sign in with a switch user. Checked against an M4250-26G4F-PoE+ on firmware 13.0.5.14.',
    class: 'infrastructure',
    features: ['http_health'],
    settings: [
      { key: 'host', label: 'Switch address', scope: 'binding', required: true },
      { key: 'port', label: 'Port (443)', scope: 'binding' },
      { key: 'https', label: 'Use https (true or false)', scope: 'design' },
      { key: 'username', label: 'Switch user', scope: 'binding', required: true },
      { key: 'password', label: 'Switch password', scope: 'secret', required: true },
      { key: 'pollMs', label: 'How often to read the switch (ms)', scope: 'design' },
    ],
    points: {
      generic: [
        { key: 'field', label: 'Reading: link, poe, poeWatts, poeEnabled (with a port), or temp, cpu, memory, poeUsedWatts, poeBudgetWatts' },
        { key: 'port', label: 'Port number (blank for a reading of the whole switch)', optional: true },
      ],
    },
    categories: ['network_switch'],
    example: { host: '<switch IP>', username: 'admin', password: '<switch password>' },
  },
  'snmp-generic': {
    name: 'Generic SNMP device',
    label: 'Network – Generic SNMP',
    group: 'network',
    make: 'Generic',
    description:
      'Any switch, access point, router, UPS or other device that answers SNMP v2c: whether it answers, its system name, uptime and location, ports that are up (IF-MIB), PoE where the device has it, and any value by its OID as a control point to watch and alert on. Not yet checked against a real device.',
    class: 'infrastructure',
    features: ['snmp'],
    settings: [
      { key: 'host', label: 'Device address', scope: 'binding', required: true },
      { key: 'port', label: 'SNMP port (161)', scope: 'binding' },
      { key: 'community', label: 'Read community (public)', scope: 'secret' },
      { key: 'writeCommunity', label: 'Write community (only to switch PoE)', scope: 'secret' },
      { key: 'pollMs', label: 'How often to read the device (ms)', scope: 'design' },
    ],
    points: { generic: [{ key: 'oid', label: 'OID (for example 1.3.6.1.2.1.1.3.0)' }] },
    categories: [
      'network_switch',
      'wireless_ap',
      'router_firewall',
      'ups',
      'server',
      'nas',
      'signage_player',
      'intercom',
      'access_control',
      'printer',
      'network_device',
    ],
    example: { host: '<device IP>', community: '<read community>' },
  },
  wiim: {
    name: 'WiiM music player',
    label: 'Music player – WiiM series',
    group: 'audio',
    make: 'WiiM',
    description:
      'Monitoring only, over the player’s own HTTP API: reports whether it is playing, paused or stopped, where the audio comes from, volume and mute, the track playing (title, artist, album, quality), and the player’s name, model and firmware. WiiM Mini, Pro, Pro Plus, Amp and Ultra, and other Linkplay-based players. Not yet verified against a real player.',
    class: 'music_player',
    features: ['now_playing', 'playback_state', 'source', 'volume'],
    settings: [
      { key: 'host', label: 'Player address', scope: 'binding', required: true },
      { key: 'port', label: 'Port (443; 80 for plain HTTP)', scope: 'binding' },
      { key: 'protocol', label: 'https or http', scope: 'design' },
      {
        key: 'allowSelfSigned',
        label: 'Accept the player’s own certificate (true)',
        scope: 'design',
      },
      { key: 'pollMs', label: 'How often to check the player (ms)', scope: 'design' },
    ],
    categories: ['music_player'],
    example: { host: '<player IP>' },
  },
  bluesound: {
    name: 'Bluesound music player (BluOS)',
    label: 'Music player – Bluesound BluOS series',
    group: 'audio',
    make: 'Bluesound',
    description:
      'Monitoring only, over the BluOS HTTP API (port 11000): reports whether the player is playing, paused or stopped, the service or input it is playing from, volume and mute, the track playing (title, artist, album, quality), and the player’s name, model and group. Node, Powernode, Vault, Pulse and the Professional B100S and B400S. Not yet verified against a real player.',
    class: 'music_player',
    features: ['now_playing', 'playback_state', 'source', 'volume'],
    settings: [
      { key: 'host', label: 'Player address', scope: 'binding', required: true },
      { key: 'port', label: 'Port (11000)', scope: 'binding' },
      { key: 'pollMs', label: 'How often to check the player (ms)', scope: 'design' },
    ],
    categories: ['music_player'],
    example: { host: '<player IP>' },
  },
};

/**
 * What a driver implies about the box it talks to: its make, and a model when the driver is for one
 * product. A device that reports its own model replaces the model; nothing is implied for a driver
 * that serves many makes (a generic camera protocol).
 */
export function inferFromDriver(driverId: string | null | undefined): {
  make?: string;
  model?: string;
} {
  const d = driverId ? BUILT_IN_DRIVERS[driverId] : undefined;
  return { ...(d?.make ? { make: d.make } : {}), ...(d?.model ? { model: d.model } : {}) };
}
