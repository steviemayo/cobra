import { checkDriverSpec, type DriverSpec } from '@kestrel/model';

// Drivers that ship with Kestrel, written in the same driver format anyone can use (see
// docs/driver-sdk.md). A device picks one as `lib:<id>`. They are bundled with the gateway, so a
// release does not need to carry them.


// Sony BRAVIA professional displays. REST calls (JSON) for power, input, volume and apps, and IRCC-IP
// (SOAP) for remote keys, both authenticated by the pre-shared key set on the display. Checked
// against Sony's published REST API and IRCC-IP reference (pro-bravia.sony.net).
const json = (method: string, params: string) =>
  `{"method":"${method}","id":1,"params":[${params}],"version":"1.0"}`;
const rest = (path: string, method: string, params: string) => ({ method: 'POST', path, body: json(method, params) });
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
      select_input: rest('/sony/avContent', 'setPlayContent', '{"uri":"extInput:hdmi?port={inputNumber}"}'),
      volume: rest('/sony/audio', 'setAudioVolume', '{"target":"speaker","volume":"{level}"}'),
      'mute.on': rest('/sony/audio', 'setAudioMute', '{"status":true}'),
      'mute.off': rest('/sony/audio', 'setAudioMute', '{"status":false}'),
      'app.launch': rest('/sony/appControl', 'setActiveApp', '{"uri":"{appId}"}'),
      ...Object.fromEntries(Object.entries(IRCC).map(([key, code]) => [`key.${key}`, ircc(code)])),
    },
    volumeScale: { min: 0, max: 100 },
    feedback: {
      poll: [{ action: rest('/sony/system', 'getPowerStatus', ''), everyMs: 10000 }],
      patterns: [
        { match: '"status"\\s*:\\s*"active"', set: 'power', value: 'on' },
        { match: '"status"\\s*:\\s*"standby"', set: 'power', value: 'off' },
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
    transport: { type: 'http', https: true, headers: { authorization: 'Basic {setting.credentials}', 'content-type': 'text/xml' } },
    settings: [{ key: 'credentials', label: 'Credentials (base64 of user:password)', type: 'secret', required: true }],
    quickActions: ['mics.privacy_mute'],
    commands: {
      'power.on': { method: 'POST', path: '/putxml', body: '<Command><Standby><Deactivate/></Standby></Command>' },
      'power.off': { method: 'POST', path: '/putxml', body: '<Command><Standby><Activate/></Standby></Command>' },
      'mute.on': { method: 'POST', path: '/putxml', body: '<Command><Audio><Microphones><Mute/></Microphones></Audio></Command>' },
      'mute.off': { method: 'POST', path: '/putxml', body: '<Command><Audio><Microphones><Unmute/></Microphones></Audio></Command>' },
      volume: { method: 'POST', path: '/putxml', body: '<Command><Audio><Volume><Set><Level>{level}</Level></Set></Volume></Audio></Command>' },
      'command.hangup': { method: 'POST', path: '/putxml', body: '<Command><Call><Disconnect/></Call></Command>' },
    },
    volumeScale: { min: 0, max: 100 },
    feedback: {
      poll: [
        { action: { method: 'GET', path: '/getxml?location=/Status/Standby/State' }, everyMs: 15000 },
        { action: { method: 'GET', path: '/getxml?location=/Status/Audio/Microphones/Mute' }, everyMs: 15000 },
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
    transport: { type: 'tcp', port: 9761, terminator: '\r', replyTerminator: 'x', keepOpen: true, timeoutMs: 2000 },
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
    description: 'Kramer matrix switchers over Protocol 3000 on TCP port 5000. Routes video (layer 1) from an input to an output.',
    transport: { type: 'tcp', port: 5000, terminator: '\r', keepOpen: true, timeoutMs: 3000 },
    commands: {
      route: { send: '#ROUTE 1,{outputNumber},{inputNumber}', expect: '@ROUTE\\s+\\d+,' },
    },
    feedback: { poll: [{ action: { send: '#ROUTE? 1,1' }, everyMs: 10000 }], patterns: [] },
  },
];

export const LIBRARY: Record<string, DriverSpec> = {};
for (const item of raw) {
  const checked = checkDriverSpec(item);
  if (!checked.ok) throw new Error(`Bundled driver is invalid: ${checked.problems.join('; ')}`);
  LIBRARY[`lib:${checked.spec.id}`] = checked.spec;
}
