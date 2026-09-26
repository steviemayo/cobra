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
];

export const LIBRARY: Record<string, DriverSpec> = {};
for (const item of raw) {
  const checked = checkDriverSpec(item);
  if (!checked.ok) throw new Error(`Bundled driver is invalid: ${checked.problems.join('; ')}`);
  LIBRARY[`lib:${checked.spec.id}`] = checked.spec;
}
