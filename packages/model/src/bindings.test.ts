import { describe, expect, it } from 'vitest';
import {
  RoomModel,
  applyBindings,
  missingBindings,
  scopeOfSetting,
  slotsFor,
  splitSettings,
  stripBindings,
  type CustomDrivers,
  type Device,
} from './index';

const device = (over: Partial<Device>): Device => ({
  id: 'd1',
  name: 'Device',
  category: 'display',
  ports: [],
  extraCapabilities: [],
  settings: {},
  ...over,
});
const room = (devices: Device[]) => RoomModel.parse({ roomType: 'meeting', devices });

const qsys = device({
  id: 'dsp',
  name: 'DSP',
  category: 'audio_matrix',
  control: { kind: 'driver', driverId: 'qsys-core' },
  settings: { host: '10.0.0.5', password: 'hunter2', gainComponent: 'Gain1', minDb: -40 },
});
const pjlink = device({
  id: 'proj',
  name: 'Projector',
  category: 'projector',
  control: { kind: 'generic', protocol: 'pjlink' },
  settings: { host: '10.0.0.9', port: 4352, password: 'pw', inputs: { in: '31' } },
});

describe('slots and scope', () => {
  it('a built-in driver says what is an address, a secret and design', () => {
    expect(slotsFor(qsys).map((s) => [s.key, s.scope, s.required])).toEqual([
      ['host', 'binding', true],
      ['username', 'binding', false],
      ['password', 'secret', false],
    ]);
    expect(scopeOfSetting(qsys, 'gainComponent')).toBe('design');
    expect(scopeOfSetting(qsys, 'password')).toBe('secret');
  });

  it('generic drivers have their own slots', () => {
    expect(slotsFor(pjlink).map((s) => s.key)).toEqual(['host', 'port', 'password']);
    const serial = device({ control: { kind: 'generic', protocol: 'serial' }, settings: { path: 'COM3' } });
    expect(slotsFor(serial).map((s) => s.key)).toEqual(['path']);
    const rest = device({ control: { kind: 'generic', protocol: 'rest' } });
    expect(scopeOfSetting(rest, 'headers')).toBe('secret');
  });

  it('a custom driver uses its own settings, and always needs an address', () => {
    const custom: CustomDrivers = {
      'custom:mine': {
        spec: {
          format: 1,
          id: 'mine',
          name: 'Mine',
          version: 1,
          description: '',
          transport: { type: 'tcp', terminator: '\r\n', keepOpen: false, timeoutMs: 2000 },
          settings: [
            { key: 'pin', label: 'PIN', type: 'secret', required: true },
            { key: 'zone', label: 'Zone', type: 'number', required: false },
          ],
          commands: { 'power.on': { send: 'ON' } },
          feedback: { poll: [], patterns: [] },
        },
      },
    };
    const d = device({ control: { kind: 'driver', driverId: 'custom:mine' } });
    expect(slotsFor(d, custom).map((s) => [s.key, s.scope])).toEqual([
      ['host', 'binding'],
      ['port', 'binding'],
      ['pin', 'secret'],
    ]);
    expect(scopeOfSetting(d, 'zone', custom)).toBe('design');
  });

  it('a device with no driver needs nothing', () => {
    expect(slotsFor(device({}))).toEqual([]);
  });
});

describe('strip and apply', () => {
  it('splits settings by scope', () => {
    const s = splitSettings(qsys);
    expect(s.design).toEqual({ gainComponent: 'Gain1', minDb: -40 });
    expect(s.binding).toEqual({ host: '10.0.0.5' });
    expect(s.secret).toEqual({ password: 'hunter2' });
  });

  it('takes addresses and logins out of the room, and puts them back', () => {
    const model = room([qsys, pjlink]);
    const { model: bare, values } = stripBindings(model);
    expect(bare.devices[0]!.settings).toEqual({ gainComponent: 'Gain1', minDb: -40 });
    expect(bare.devices[1]!.settings).toEqual({ inputs: { in: '31' } });
    expect(values).toEqual({
      dsp: { host: '10.0.0.5', password: 'hunter2' },
      proj: { host: '10.0.0.9', port: 4352, password: 'pw' },
    });
    expect(applyBindings(bare, values)).toEqual(model);
  });

  it('does not change the room it is given', () => {
    const model = room([qsys]);
    const before = structuredClone(model);
    stripBindings(model);
    applyBindings(model, { dsp: { host: '1.1.1.1' } });
    expect(model).toEqual(before);
  });

  it('bindings win over anything inline', () => {
    const model = room([device({ id: 'a', settings: { host: 'old', keep: 1 } })]);
    const out = applyBindings(model, { a: { host: 'new' } });
    expect(out.devices[0]!.settings).toEqual({ host: 'new', keep: 1 });
  });
});

describe('missing bindings', () => {
  it('lists required addresses nobody has entered', () => {
    const { model } = stripBindings(room([qsys, pjlink]));
    const missing = missingBindings(model, { proj: { host: '10.0.0.9' } });
    expect(missing).toEqual([
      { deviceId: 'dsp', deviceName: 'DSP', key: 'host', label: 'Core address' },
    ]);
  });

  it('counts an inline value and ignores optional slots and devices with no driver', () => {
    const model = room([qsys, device({ id: 'plain' })]);
    expect(missingBindings(model, {})).toEqual([]);
    const bare = stripBindings(model).model;
    expect(missingBindings(bare, { dsp: { host: '' } })).toHaveLength(1);
    expect(missingBindings(bare, { dsp: { host: '10.0.0.5' } })).toEqual([]);
  });
});
