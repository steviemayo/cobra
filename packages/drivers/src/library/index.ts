import { checkDriverSpec, type DriverSpec } from '@kestrel/model';

// Drivers that ship with Kestrel, written in the same driver format anyone can use (see
// docs/driver-sdk.md). A device picks one as `lib:<id>`. They are bundled with the gateway, so a
// release does not need to carry them.

const raw: unknown[] = [
  {
    id: 'extron-sis',
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
];

export const LIBRARY: Record<string, DriverSpec> = {};
for (const item of raw) {
  const checked = checkDriverSpec(item);
  if (!checked.ok) throw new Error(`Bundled driver is invalid: ${checked.problems.join('; ')}`);
  LIBRARY[`lib:${checked.spec.id}`] = checked.spec;
}
