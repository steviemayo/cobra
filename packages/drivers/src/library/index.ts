import { checkDriverSpec, type DriverSpec } from '@kestrel/model';

// Drivers that ship with Kestrel, written in the same driver format anyone can use (see
// docs/driver-sdk.md). A device picks one as `lib:<id>`. They are bundled with the gateway, so a
// release does not need to carry them.

// Sony BRAVIA professional displays. REST calls (JSON) for power, input, volume and apps, and IRCC-IP
// (SOAP) for remote keys, both authenticated by the pre-shared key set on the display. Checked
// against Sony's published REST API and IRCC-IP reference (pro-bravia.sony.net).
const json = (method: string, params: string) =>
  `{"method":"${method}","id":1,"params":[${params}],"version":"1.0"}`;
const rest = (path: string, method: string, params: string) => ({
  method: 'POST',
  path,
  body: json(method, params),
});
// IRCC codes from Sony's IRCC-IP reference. "Menu" is the Options key: Sony has no separate Menu.
const IRCC: Record<string, string> = {
  up: 'AAAAAQAAAAEAAAB0Aw==',
  down: 'AAAAAQAAAAEAAAB1Aw==',
  left: 'AAAAAQAAAAEAAAA0Aw==',
  right: 'AAAAAQAAAAEAAAAzAw==',
  ok: 'AAAAAQAAAAEAAABlAw==',
  home: 'AAAAAQAAAAEAAABgAw==',
  menu: 'AAAAAgAAAJcAAAA2Aw==',
  back: 'AAAAAgAAAJcAAAAjAw==',
  play: 'AAAAAgAAAJcAAAAaAw==',
  pause: 'AAAAAgAAAJcAAAAZAw==',
  stop: 'AAAAAgAAAJcAAAAYAw==',
  rewind: 'AAAAAgAAAJcAAAA8Aw==',
  forward: 'AAAAAgAAAJcAAAA9Aw==',
};
const ircc = (code: string) => ({
  method: 'POST',
  path: '/sony/ircc',
  headers: {
    'content-type': 'text/xml; charset=UTF-8',
    SOAPACTION: '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"',
  },
  body:
    '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    `<u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>${code}</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>`,
});

function bravia(): unknown {
  return {
    id: 'sony-bravia',
    class: 'display',
    features: ['remote_keys', 'media_keys', 'apps', 'builtin_audio'],
    name: 'Sony BRAVIA professional display',
    description:
      'Sony BRAVIA professional displays over their REST and IRCC-IP interfaces. On the display, turn on IP control and set a pre-shared key. List the apps to show in the device settings as "apps": [{ "id": "<app uri>", "name": "Netflix" }].',
    transport: { type: 'http', headers: { 'X-Auth-PSK': '{setting.psk}' }, timeoutMs: 3000 },
    settings: [{ key: 'psk', label: 'Pre-shared key', type: 'secret', required: true }],
    commands: {
      'power.on': rest('/sony/system', 'setPowerStatus', '{"status":true}'),
      'power.off': rest('/sony/system', 'setPowerStatus', '{"status":false}'),
      select_input: rest(
        '/sony/avContent',
        'setPlayContent',
        '{"uri":"extInput:hdmi?port={inputNumber}"}',
      ),
      volume: rest('/sony/audio', 'setAudioVolume', '{"target":"speaker","volume":"{level}"}'),
      'mute.on': rest('/sony/audio', 'setAudioMute', '{"status":true}'),
      'mute.off': rest('/sony/audio', 'setAudioMute', '{"status":false}'),
      'app.launch': rest('/sony/appControl', 'setActiveApp', '{"uri":"{appId}"}'),
      ...Object.fromEntries(Object.entries(IRCC).map(([key, code]) => [`key.${key}`, ircc(code)])),
    },
    volumeScale: { min: 0, max: 100 },
    feedback: {
      poll: [
        { action: rest('/sony/system', 'getPowerStatus', ''), everyMs: 10000 },
        // Who the display is, for the register: model, serial number, MAC and firmware in one call.
        { action: rest('/sony/system', 'getSystemInformation', ''), everyMs: 300000 },
      ],
      patterns: [
        { match: '"status"\\s*:\\s*"active"', set: 'power', value: 'on' },
        { match: '"status"\\s*:\\s*"standby"', set: 'power', value: 'off' },
        { match: '"model"\\s*:\\s*"([^"]+)"', set: 'model', value: '$1' },
        { match: '"serial"\\s*:\\s*"([^"]+)"', set: 'serial', value: '$1' },
        { match: '"macAddr"\\s*:\\s*"([^"]+)"', set: 'mac', value: '$1' },
        { match: '"fwVersion"\\s*:\\s*"([^"]+)"', set: 'firmware', value: '$1' },
      ],
    },
  };
}

const raw: unknown[] = [
  {
    id: 'extron-sis',
    class: 'video_switching',
    features: ['route'],
    name: 'Extron matrix switcher (SIS)',
    description: 'Extron matrix switchers over Telnet (port 23). Ties one input to one output.',
    transport: { type: 'tcp', port: 23, terminator: '\r\n', keepOpen: true },
    commands: {
      route: { send: '{inputNumber}*{outputNumber}!', expect: '^Out' },
      preset: { send: '{name}.', expect: '^Rpr' },
    },
    feedback: {
      poll: [{ action: { send: 'I' }, everyMs: 10000 }],
      patterns: [],
    },
  },
  {
    id: 'cisco-roomos',
    class: 'conference_system',
    features: ['standby', 'mic_mute', 'volume', 'hangup'],
    name: 'Cisco RoomOS video conferencing',
    description:
      'Cisco Room and Board devices over their HTTP API (/putxml). Set "credentials" to the base64 of "username:password".',
    transport: {
      type: 'http',
      https: true,
      headers: { authorization: 'Basic {setting.credentials}', 'content-type': 'text/xml' },
    },
    settings: [
      {
        key: 'credentials',
        label: 'Credentials (base64 of user:password)',
        type: 'secret',
        required: true,
      },
    ],
    quickActions: ['mics.privacy_mute'],
    commands: {
      'power.on': {
        method: 'POST',
        path: '/putxml',
        body: '<Command><Standby><Deactivate/></Standby></Command>',
      },
      'power.off': {
        method: 'POST',
        path: '/putxml',
        body: '<Command><Standby><Activate/></Standby></Command>',
      },
      'mute.on': {
        method: 'POST',
        path: '/putxml',
        body: '<Command><Audio><Microphones><Mute/></Microphones></Audio></Command>',
      },
      'mute.off': {
        method: 'POST',
        path: '/putxml',
        body: '<Command><Audio><Microphones><Unmute/></Microphones></Audio></Command>',
      },
      volume: {
        method: 'POST',
        path: '/putxml',
        body: '<Command><Audio><Volume><Set><Level>{level}</Level></Set></Volume></Audio></Command>',
      },
      'command.hangup': {
        method: 'POST',
        path: '/putxml',
        body: '<Command><Call><Disconnect/></Call></Command>',
      },
    },
    volumeScale: { min: 0, max: 100 },
    feedback: {
      poll: [
        {
          action: { method: 'GET', path: '/getxml?location=/Status/Standby/State' },
          everyMs: 15000,
        },
        {
          action: { method: 'GET', path: '/getxml?location=/Status/Audio/Microphones/Mute' },
          everyMs: 15000,
        },
      ],
      patterns: [
        { match: '<State[^>]*>Standby</State>', set: 'power', value: 'off' },
        { match: '<State[^>]*>Off</State>', set: 'power', value: 'on' },
        { match: '<Mute[^>]*>On</Mute>', set: 'muted', value: 'on' },
        { match: '<Mute[^>]*>Off</Mute>', set: 'muted', value: 'off' },
      ],
    },
  },
  {
    id: 'shelly-relay',
    class: 'relay',
    features: ['up_down', 'on_off'],
    name: 'Shelly relay (screens and lifters)',
    description:
      'Motorised screens and lifters driven through a Shelly relay (Gen 1 HTTP API): channel 0 lowers, channel 1 raises, for "seconds" seconds.',
    transport: { type: 'http', timeoutMs: 3000 },
    settings: [{ key: 'seconds', label: 'Run time (seconds)', type: 'number', default: 30 }],
    commands: {
      'command.down': { method: 'GET', path: '/relay/0?turn=on&timer={setting.seconds}' },
      'command.up': { method: 'GET', path: '/relay/1?turn=on&timer={setting.seconds}' },
      'power.on': { method: 'GET', path: '/relay/0?turn=on' },
      'power.off': { method: 'GET', path: '/relay/0?turn=off' },
    },
    feedback: {
      poll: [{ action: { method: 'GET', path: '/relay/0' }, everyMs: 20000 }],
      patterns: [],
    },
  },
  {
    id: 'lutron-lip',
    class: 'environmental',
    features: ['scene', 'zone_level'],
    name: 'Lutron lighting (Integration Protocol)',
    description:
      'Lutron processors over the Integration Protocol (Telnet, port 23) with integration access enabled without a login. Scenes press a keypad button.',
    transport: { type: 'tcp', port: 23, terminator: '\r\n', keepOpen: true },
    settings: [
      { key: 'zone', label: 'Zone (output) number', type: 'number', default: 1 },
      { key: 'keypad', label: 'Keypad (device) number', type: 'number', default: 1 },
    ],
    commands: {
      'power.on': { send: '#OUTPUT,{setting.zone},1,100' },
      'power.off': { send: '#OUTPUT,{setting.zone},1,0' },
      volume: { send: '#OUTPUT,{setting.zone},1,{level}' },
      scene: { send: '#DEVICE,{setting.keypad},{name},3' },
    },
    volumeScale: { min: 0, max: 100 },
    feedback: {
      poll: [{ action: { send: '?OUTPUT,{setting.zone},1' }, everyMs: 10000 }],
      patterns: [{ match: '~OUTPUT,\\d+,1,(\\d+(?:\\.\\d+)?)', set: 'volume', value: '$1' }],
    },
  },
  bravia(),
  {
    // LG signage and professional displays over their RS-232C protocol on the network port (TCP 9761).
    // Checked against LG's RS-232C external control reference: a command is `<c1><c2> <set id> <data>`
    // ended by CR, and the answer is `<c2> <set id> OK<data>x`, ended by "x". Volume is two hex digits
    // (00 to 64 is 0 to 100). Input codes 90 and 91 are HDMI 1 and 2 (DTV); other inputs are not offered.
    id: 'lg-signage',
    class: 'display',
    features: ['blank', 'builtin_audio'],
    name: 'LG signage display',
    description:
      'LG signage and professional displays over the network port (TCP 9761). Turn on network control on the display. "Set ID" is the display Set ID (01 unless changed). Ports in1 and in2 select HDMI 1 and HDMI 2.',
    transport: {
      type: 'tcp',
      port: 9761,
      terminator: '\r',
      replyTerminator: 'x',
      keepOpen: true,
      timeoutMs: 2000,
    },
    settings: [{ key: 'setId', label: 'Set ID', type: 'string', scope: 'binding', default: '01' }],
    quickActions: ['display.blank'],
    commands: {
      'power.on': { send: 'ka {setting.setId} 01' },
      'power.off': { send: 'ka {setting.setId} 00' },
      select_input: { send: 'xb {setting.setId} {inputHex}' },
      volume: { send: 'kf {setting.setId} {levelHex}' },
      'mute.on': { send: 'ke {setting.setId} 00' },
      'mute.off': { send: 'ke {setting.setId} 01' },
      'blank.on': { send: 'kd {setting.setId} 01' },
      'blank.off': { send: 'kd {setting.setId} 00' },
    },
    volumeScale: { min: 0, max: 100 },
    feedback: {
      poll: [
        { action: { send: 'ka {setting.setId} FF' }, everyMs: 10000 },
        { action: { send: 'ke {setting.setId} FF' }, everyMs: 10000 },
        { action: { send: 'kd {setting.setId} FF' }, everyMs: 10000 },
      ],
      patterns: [
        { match: '^\\s*a \\d+ OK01\\s*$', set: 'power', value: 'on' },
        { match: '^\\s*a \\d+ OK00\\s*$', set: 'power', value: 'off' },
        { match: '^\\s*e \\d+ OK00\\s*$', set: 'muted', value: 'on' },
        { match: '^\\s*e \\d+ OK01\\s*$', set: 'muted', value: 'off' },
        { match: '^\\s*d \\d+ OK01\\s*$', set: 'blanked', value: 'on' },
        { match: '^\\s*d \\d+ OK00\\s*$', set: 'blanked', value: 'off' },
      ],
    },
  },
  {
    // Blustream PWR8IEC IEC power controller (8 outlets; the 2- and 4-outlet PWR2IEC/PWR4IEC share
    // the same command set, just with fewer of the outlets below actually wired to anything).
    // ASCII console over Telnet, checked against Blustream's command reference. The reference does
    // not show reply text for any command, so nothing is read back: a command counts as done once
    // it is sent, and "online" only means the gateway could open the connection.
    id: 'blustream-pwr8iec',
    class: 'relay',
    features: ['on_off'],
    name: 'Blustream PWR8IEC power controller',
    description:
      'Blustream PWR8IEC / PWR4IEC / PWR2IEC IEC power controllers, over the Telnet console (port 23). "Power" switches every outlet at once; the per-outlet commands (command.outlet1_on, command.outlet1_off, and so on up to outlet8) switch one, for however many the physical unit has.',
    transport: { type: 'tcp', port: 23, terminator: '\r\n', timeoutMs: 3000 },
    commands: {
      'power.on': { send: 'ALLOUT ON' },
      'power.off': { send: 'ALLOUT OFF' },
      ...Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => i + 1).flatMap((n) => [
          [`command.outlet${n}_on`, { send: `OUTLET ${n} ON` }],
          [`command.outlet${n}_off`, { send: `OUTLET ${n} OFF` }],
        ]),
      ),
    },
    feedback: { poll: [], patterns: [] },
  },
  {
    // Kramer matrix switchers over Protocol 3000 (TCP 5000, commands ended by CR). `#ROUTE layer,dest,src`
    // is answered `~nn@ROUTE layer,dest,src`; layer 1 is video. Checked against Kramer's Protocol 3000
    // reference.
    id: 'kramer-p3000',
    class: 'video_switching',
    features: ['route'],
    name: 'Kramer matrix switcher (Protocol 3000)',
    description:
      'Kramer matrix switchers over Protocol 3000 on TCP port 5000. Routes video (layer 1) from an input to an output.',
    transport: { type: 'tcp', port: 5000, terminator: '\r', keepOpen: true, timeoutMs: 3000 },
    commands: {
      route: { send: '#ROUTE 1,{outputNumber},{inputNumber}', expect: '@ROUTE\\s+\\d+,' },
    },
    feedback: { poll: [{ action: { send: '#ROUTE? 1,1' }, everyMs: 10000 }], patterns: [] },
  },
  {
    // Samsung MDC (Multiple Display Control) over TCP 1515. A frame is AA, command, display ID, data
    // length, data, then a check byte: the sum of every byte after the AA, modulo 256. A reply is
    // AA FF id length 41 command data... (41 is ACK, 4E is NAK). Checked against Samsung's MDC protocol
    // reference (command 0x11 power, 0x12 volume, 0x13 mute, 0x14 input source, 0x00 status). Not yet
    // checked against a real display.
    id: 'samsung-mdc',
    class: 'display',
    features: ['builtin_audio'],
    name: 'Samsung MDC display',
    description:
      'Samsung commercial displays (QM, QB, QH, OM and similar) over MDC on TCP 1515. Turn on MDC over the network in the display menu. "Display ID" is the display ID in hex (FE addresses whichever display answers; use 00 or 01 when the display has an ID set). Ports in1 to in4 select HDMI 1, HDMI 2, HDMI 3 and DisplayPort.',
    transport: {
      type: 'tcp',
      port: 1515,
      binary: true,
      keepOpen: true,
      timeoutMs: 2000,
      checksum: { type: 'sum8', from: 1 },
    },
    settings: [
      {
        key: 'displayId',
        label: 'Display ID (hex)',
        type: 'string',
        scope: 'binding',
        default: 'FE',
      },
    ],
    inputCodes: { in1: '21', in2: '23', in3: '31', in4: '25' },
    commands: {
      'power.on': { hex: 'AA 11 {setting.displayId} 01 01 {checksum}', expect: '^AA FF [0-9A-F]{2} 03 41 11' },
      'power.off': { hex: 'AA 11 {setting.displayId} 01 00 {checksum}', expect: '^AA FF [0-9A-F]{2} 03 41 11' },
      select_input: { hex: 'AA 14 {setting.displayId} 01 {inputCode} {checksum}' },
      volume: { hex: 'AA 12 {setting.displayId} 01 {levelHex} {checksum}' },
      'mute.on': { hex: 'AA 13 {setting.displayId} 01 01 {checksum}' },
      'mute.off': { hex: 'AA 13 {setting.displayId} 01 00 {checksum}' },
    },
    volumeScale: { min: 0, max: 100 },
    feedback: {
      // Status control: power, volume, mute, input and aspect in one reply.
      poll: [{ action: { hex: 'AA 00 {setting.displayId} 00 {checksum}' }, everyMs: 5000 }],
      patterns: [
        { match: 'AA FF [0-9A-F]{2} 09 41 00 01 ', set: 'power', value: 'on' },
        { match: 'AA FF [0-9A-F]{2} 09 41 00 00 ', set: 'power', value: 'off' },
        { match: 'AA FF [0-9A-F]{2} 03 41 11 01', set: 'power', value: 'on' },
        { match: 'AA FF [0-9A-F]{2} 03 41 11 00', set: 'power', value: 'off' },
        { match: 'AA FF [0-9A-F]{2} 09 41 00 [0-9A-F]{2} [0-9A-F]{2} 01 ', set: 'muted', value: 'on' },
        { match: 'AA FF [0-9A-F]{2} 09 41 00 [0-9A-F]{2} [0-9A-F]{2} 00 ', set: 'muted', value: 'off' },
      ],
    },
  },
  {
    // Philips professional displays over SICP on TCP 5000. A frame is size, monitor ID, group, data,
    // then the XOR of every byte before it; size counts the whole frame. Checked against the Philips
    // SICP specification V2.03 (0x18 power, 0xAC input, 0x44 volume, 0x19 power state, 0xAD source
    // state). Platforms without a separate audio-out level answer the volume command differently.
    // Not yet checked against a real display.
    id: 'philips-sicp',
    class: 'display',
    features: ['builtin_audio'],
    name: 'Philips SICP display',
    description:
      'Philips professional displays (BDL series and similar) over SICP on TCP 5000. "Monitor ID" is the display\'s monitor ID in hex (01 unless changed). Ports in1 to in6 select HDMI 1, HDMI 2, HDMI 3, HDMI 4, DisplayPort and DVI-D. Volume is set on the speakers and the audio out together; there is no mute command.',
    transport: {
      type: 'tcp',
      port: 5000,
      binary: true,
      keepOpen: true,
      timeoutMs: 2000,
      checksum: { type: 'xor8', from: 0 },
    },
    settings: [
      {
        key: 'monitorId',
        label: 'Monitor ID (hex)',
        type: 'string',
        scope: 'binding',
        default: '01',
      },
    ],
    inputCodes: { in1: '0D', in2: '06', in3: '0F', in4: '19', in5: '0A', in6: '0E' },
    commands: {
      'power.on': { hex: '06 {setting.monitorId} 00 18 02 {checksum}' },
      'power.off': { hex: '06 {setting.monitorId} 00 18 01 {checksum}' },
      select_input: { hex: '09 {setting.monitorId} 00 AC {inputCode} 09 01 00 {checksum}' },
      volume: { hex: '07 {setting.monitorId} 00 44 {levelHex} {levelHex} {checksum}' },
    },
    volumeScale: { min: 0, max: 100 },
    feedback: {
      poll: [{ action: { hex: '05 {setting.monitorId} 00 19 {checksum}' }, everyMs: 10000 }],
      patterns: [
        { match: '06 [0-9A-F]{2} [0-9A-F]{2} 19 02', set: 'power', value: 'on' },
        { match: '06 [0-9A-F]{2} [0-9A-F]{2} 19 01', set: 'power', value: 'off' },
      ],
    },
  },
  {
    // Sharp NEC Display Solutions external control over TCP 7142. A message is SOH, 0, destination
    // ID, 0, type, two ASCII length digits, STX, data, ETX, a check byte (the XOR of every byte from
    // the 0 after SOH to ETX) and CR; everything between STX and ETX is ASCII hex. Type A is a command,
    // E sets a parameter. Checked against NEC's External Control specification (power C203D6 and 01D6,
    // input VCP 00-60, volume VCP 00-62). Not yet checked against a real display.
    id: 'sharp-nec',
    class: 'display',
    features: ['builtin_audio'],
    name: 'Sharp NEC display',
    description:
      'Sharp NEC large format displays (MultiSync, and Sharp-branded NEC panels) over their external control protocol on TCP 7142. "Monitor ID" is the display ID as an ASCII letter in hex (41 is ID 1, 42 is ID 2, and so on). Ports in1 to in3 select HDMI 1, HDMI 2 and DisplayPort 1. There is no mute command in this protocol.',
    transport: {
      type: 'tcp',
      port: 7142,
      terminator: '\r',
      replyTerminator: '\r',
      keepOpen: false,
      timeoutMs: 3000,
      checksum: { type: 'xor8', from: 1 },
    },
    settings: [
      {
        key: 'monitorId',
        label: 'Monitor ID (hex ASCII letter, 41 = ID 1)',
        type: 'string',
        scope: 'binding',
        default: '41',
      },
    ],
    // Input value as four ASCII hex characters: 0011 HDMI 1, 0012 HDMI 2, 000F DisplayPort 1.
    inputCodes: { in1: '30303131', in2: '30303132', in3: '30303046' },
    commands: {
      'power.on': {
        hex: '01 30 {setting.monitorId} 30 41 30 43 02 43 32 30 33 44 36 30 30 30 31 03 {checksum} 0D',
        expect: '00C203D6',
      },
      'power.off': {
        hex: '01 30 {setting.monitorId} 30 41 30 43 02 43 32 30 33 44 36 30 30 30 34 03 {checksum} 0D',
        expect: '00C203D6',
      },
      select_input: {
        hex: '01 30 {setting.monitorId} 30 45 30 41 02 30 30 36 30 {inputCode} 03 {checksum} 0D',
      },
      volume: {
        hex: '01 30 {setting.monitorId} 30 45 30 41 02 30 30 36 32 {levelHexAscii4} 03 {checksum} 0D',
      },
    },
    volumeScale: { min: 0, max: 100 },
    feedback: {
      poll: [
        {
          action: { hex: '01 30 {setting.monitorId} 30 41 30 36 02 30 31 44 36 03 {checksum} 0D' },
          everyMs: 10000,
        },
      ],
      patterns: [
        { match: '0200D60000040001', set: 'power', value: 'on' },
        { match: '0200D6000004000[24]', set: 'power', value: 'off' },
        { match: '00C203D60001', set: 'power', value: 'on' },
        { match: '00C203D60004', set: 'power', value: 'off' },
      ],
    },
  },
  {
    // Shure MXA microphones over TCP 2202. Messages are ASCII in angle brackets: < GET name >,
    // < SET name value >, answered by < REP name value > (also sent whenever the value changes, so the
    // connection is kept open). Checked against the MXA920 command strings (DEVICE_AUDIO_MUTE, MODEL,
    // SERIAL_NUM, FW_VER, FLASH); the MXA901, 902, 925, 710 and 320 publish the same strings. Not yet
    // checked against a real microphone.
    id: 'shure-mxa',
    class: 'conferencing_mic',
    features: ['privacy_mute'],
    name: 'Shure MXA microphone',
    description:
      'Shure Microflex Advance microphones (MXA901, MXA902, MXA925, MXA710, MXA320 and the same family) over command strings on TCP 2202: mute state, mute on and off, and the model, serial number and firmware. "Identify" flashes the unit\'s lights.',
    transport: {
      type: 'tcp',
      port: 2202,
      terminator: '',
      replyTerminator: '>',
      keepOpen: true,
      timeoutMs: 3000,
    },
    quickActions: ['mics.privacy_mute'],
    commands: {
      'mute.on': { send: '< SET DEVICE_AUDIO_MUTE ON >', expect: 'REP DEVICE_AUDIO_MUTE ON' },
      'mute.off': { send: '< SET DEVICE_AUDIO_MUTE OFF >', expect: 'REP DEVICE_AUDIO_MUTE OFF' },
      'command.identify_on': { send: '< SET FLASH ON >' },
      'command.identify_off': { send: '< SET FLASH OFF >' },
    },
    feedback: {
      poll: [
        { action: { send: '< GET DEVICE_AUDIO_MUTE >' }, everyMs: 10000 },
        { action: { send: '< GET MODEL >' }, everyMs: 300000 },
        { action: { send: '< GET SERIAL_NUM >' }, everyMs: 300000 },
        { action: { send: '< GET FW_VER >' }, everyMs: 300000 },
      ],
      patterns: [
        { match: 'REP DEVICE_AUDIO_MUTE (ON|OFF)', set: 'muted', value: '$1' },
        { match: 'REP MODEL \\{?([A-Za-z0-9._ -]+)', set: 'model', value: '$1' },
        { match: 'REP SERIAL_NUM \\{?([A-Za-z0-9]+)', set: 'serial', value: '$1' },
        { match: 'REP FW_VER \\{?([0-9.*]+)', set: 'firmware', value: '$1' },
      ],
    },
  },
  {
    // Sennheiser TeamConnect Ceiling 2 over SSC (Sennheiser Sound Control, JSON) on UDP 45: one JSON
    // message per datagram, a null value asks and a value sets. Checked against the TCC 2 SSC
    // developer's guide v1.8.0 (/audio/mute, /device/identity/*). Not yet checked against a real unit.
    id: 'sennheiser-tcc2',
    class: 'conferencing_mic',
    features: ['privacy_mute'],
    name: 'Sennheiser TeamConnect Ceiling 2',
    description:
      'Sennheiser TeamConnect Ceiling 2 over the Sennheiser Sound Control protocol on UDP 45: mute state, mute on and off, and the product, serial number and firmware version.',
    transport: { type: 'udp', port: 45, timeoutMs: 1500 },
    quickActions: ['mics.privacy_mute'],
    commands: {
      'mute.on': { send: '{"audio":{"mute":true}}', expect: '"mute"\\s*:\\s*true' },
      'mute.off': { send: '{"audio":{"mute":false}}', expect: '"mute"\\s*:\\s*false' },
    },
    feedback: {
      poll: [
        { action: { send: '{"audio":{"mute":null}}' }, everyMs: 10000 },
        {
          action: { send: '{"device":{"identity":{"product":null,"version":null,"serial":null}}}' },
          everyMs: 300000,
        },
      ],
      patterns: [
        { match: '"mute"\\s*:\\s*true', set: 'muted', value: 'on' },
        { match: '"mute"\\s*:\\s*false', set: 'muted', value: 'off' },
        { match: '"product"\\s*:\\s*"([^"]+)"', set: 'model', value: '$1' },
        { match: '"serial"\\s*:\\s*"([^"]+)"', set: 'serial', value: '$1' },
        { match: '"version"\\s*:\\s*"([^"]+)"', set: 'firmware', value: '$1' },
      ],
    },
  },
  {
    // Sennheiser TeamConnect Ceiling Medium over SSCv2: a REST API over HTTPS (port 443) with HTTP
    // basic authentication, user "api" and the third-party password. Third-party access is off from
    // the factory: turn it on and set the password in Sennheiser Control Cockpit. Monitoring only for
    // now: it reads /api/device/identity (product, serial, vendor), checked against the SSCv2
    // specification. The mute resource is in the product's OpenAPI file, which is not built in yet.
    id: 'sennheiser-tcc-medium',
    class: 'conferencing_mic',
    features: [],
    name: 'Sennheiser TeamConnect Ceiling Medium',
    description:
      'Sennheiser TeamConnect Ceiling Medium over SSCv2 (HTTPS, port 443). Monitoring only: whether it answers, its product name and serial number. In Sennheiser Control Cockpit, enable third party access and set a password, then set "credentials" to the base64 of api:<that password>.',
    transport: { type: 'http', https: true, allowSelfSigned: true, timeoutMs: 4000 },
    settings: [
      {
        key: 'credentials',
        label: 'Credentials (base64 of api:password)',
        type: 'secret',
        required: true,
      },
    ],
    commands: {},
    feedback: {
      poll: [
        {
          action: {
            method: 'GET',
            path: '/api/device/identity',
            headers: { authorization: 'Basic {setting.credentials}' },
          },
          everyMs: 30000,
        },
      ],
      patterns: [
        { match: '"product"\\s*:\\s*"([^"]+)"', set: 'model', value: '$1' },
        { match: '"serial"\\s*:\\s*"([^"]+)"', set: 'serial', value: '$1' },
        { match: '"version"\\s*:\\s*"([^"]+)"', set: 'firmware', value: '$1' },
      ],
    },
  },
  {
    // Sennheiser TeamConnect Bar S and M over SSCv2 (see the Ceiling Medium note above).
    id: 'sennheiser-tc-bar',
    class: 'conference_system',
    features: [],
    name: 'Sennheiser TeamConnect Bar',
    description:
      'Sennheiser TeamConnect Bar S and M over SSCv2 (HTTPS, port 443). Monitoring only: whether it answers, its product name and serial number. In Sennheiser Control Cockpit, enable third party access and set a password, then set "credentials" to the base64 of api:<that password>.',
    transport: { type: 'http', https: true, allowSelfSigned: true, timeoutMs: 4000 },
    settings: [
      {
        key: 'credentials',
        label: 'Credentials (base64 of api:password)',
        type: 'secret',
        required: true,
      },
    ],
    commands: {},
    feedback: {
      poll: [
        {
          action: {
            method: 'GET',
            path: '/api/device/identity',
            headers: { authorization: 'Basic {setting.credentials}' },
          },
          everyMs: 30000,
        },
      ],
      patterns: [
        { match: '"product"\\s*:\\s*"([^"]+)"', set: 'model', value: '$1' },
        { match: '"serial"\\s*:\\s*"([^"]+)"', set: 'serial', value: '$1' },
        { match: '"version"\\s*:\\s*"([^"]+)"', set: 'firmware', value: '$1' },
      ],
    },
  },
];

export const LIBRARY: Record<string, DriverSpec> = {};
for (const item of raw) {
  const checked = checkDriverSpec(item);
  if (!checked.ok) throw new Error(`Bundled driver is invalid: ${checked.problems.join('; ')}`);
  LIBRARY[`lib:${checked.spec.id}`] = checked.spec;
}
