import { describe, expect, it } from 'vitest';
import {
  checkDriverSpec,
  commandValues,
  escapeJson,
  escapeLine,
  escapePath,
  renderTemplate,
  resolveSettings,
  DriverSpec,
} from './driver-spec';

const projector = () => ({
  id: 'acme-projector',
  name: 'Acme projector',
  transport: { type: 'tcp' as const, port: 4352 },
  settings: [{ key: 'password', label: 'Password', type: 'secret' as const }],
  commands: {
    'power.on': { send: '%1POWR 1' },
    'power.off': { send: '%1POWR 0' },
    volume: { send: 'VOL {level} {setting.password}' },
    route: { send: 'SW I{inputNumber} O{outputNumber}' },
  },
  volumeScale: { min: -40, max: 0 },
});

describe('checking a driver', () => {
  it('accepts a sound driver and fills in the defaults', () => {
    const r = checkDriverSpec(projector());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec).toMatchObject({ version: 1, format: 1, transport: { terminator: '\r\n', keepOpen: false } });
  });

  it('says what is wrong, in sentences', () => {
    const bad = (over: Record<string, unknown>) => {
      const r = checkDriverSpec({ ...projector(), ...over });
      return r.ok ? [] : r.problems;
    };
    expect(bad({ id: 'Bad Id' })[0]).toContain('lowercase');
    expect(bad({ commands: {} })[0]).toContain('at least one command');
    expect(bad({ commands: { reboot: { send: 'x' } } })[0]).toContain('not a command Kestrel knows');
    expect(bad({ commands: { volume: { send: 'VOL {volume}' } } }).join()).toContain('{volume} is not available');
    expect(bad({ commands: { 'power.on': { send: 'X {setting.nope}' } } }).join()).toContain('no such setting');
    expect(bad({ commands: { 'power.on': { path: '/x' } } }).join()).toContain('needs "send"');
    expect(bad({ commands: { 'power.on': { send: 'x', expect: '(' } } }).join()).toContain('not a valid regular expression');
    expect(bad({ settings: [{ key: 'a', label: 'A' }, { key: 'a', label: 'B' }] }).join()).toContain('listed twice');
  });

  it('checks feedback patterns against the groups they read', () => {
    const withPattern = (p: Record<string, unknown>) =>
      checkDriverSpec({ ...projector(), feedback: { poll: [{ action: { send: 'STATUS?' } }], patterns: [p] } });
    expect(withPattern({ match: '^POWER=(ON|OFF)$', set: 'power', value: '$1' }).ok).toBe(true);
    const r = withPattern({ match: '^POWER=ON$', set: 'power', value: '$1' });
    expect(!r.ok && r.problems[0]).toContain('has 0 groups');
    const r2 = withPattern({ match: '(', set: 'power', value: 'on' });
    expect(!r2.ok && r2.problems[0]).toContain('regular expression');
    const noScale = checkDriverSpec({ ...projector(), volumeScale: undefined, commands: { volume: { send: 'V {level}' } }, feedback: { poll: [{ action: { send: 'V?' } }], patterns: [{ match: 'V=(\\d+)', set: 'volume', value: '$1' }] } });
    expect(!noScale.ok && noScale.problems[0]).toContain('volumeScale');
  });

  it('keeps TCP and HTTP commands apart', () => {
    const http = { id: 'acme-lights', name: 'Lights', transport: { type: 'http' as const }, commands: { scene: { method: 'POST' as const, path: '/scene/{name}' } } };
    expect(checkDriverSpec(http).ok).toBe(true);
    const mixed = checkDriverSpec({ ...http, commands: { scene: { send: 'x' } } });
    expect(!mixed.ok && mixed.problems.join()).toContain('"send" is for TCP');
    const noSlash = checkDriverSpec({ ...http, commands: { scene: { path: 'scene' } } });
    expect(!noSlash.ok && noSlash.problems.join()).toContain('must start with /');
  });

  it('a quick action needs the commands that carry it out', () => {
    const blank = { ...projector(), quickActions: ['display.blank'] };
    const missing = checkDriverSpec(blank);
    expect(!missing.ok && missing.problems.join()).toContain('needs the command “blank.on”');
    const ok = checkDriverSpec({
      ...blank,
      commands: { ...projector().commands, 'blank.on': { send: 'BLANK 1' }, 'blank.off': { send: 'BLANK 0' } },
      feedback: { poll: [{ action: { send: 'BLANK?' } }], patterns: [{ match: '^BLANK=1$', set: 'blanked', value: 'on' }] },
    });
    expect(ok.ok).toBe(true);
    expect(DriverSpec.safeParse({ ...projector(), quickActions: ['display.explode'] }).success).toBe(false);
  });

  it('leaves quickActions out of a driver that does not use them, so its signed hash is unchanged', () => {
    const r = checkDriverSpec(projector());
    expect(r.ok && 'quickActions' in r.spec).toBe(false);
  });

  it('refuses unknown fields, so typos do not silently do nothing', () => {
    expect(DriverSpec.safeParse({ ...projector(), extra: 1 }).success).toBe(false);
  });

  it('feedback on a one-shot TCP driver needs something to poll or a held connection', () => {
    const r = checkDriverSpec({ ...projector(), feedback: { poll: [], patterns: [{ match: 'x', set: 'power', value: 'on' }] } });
    expect(!r.ok && r.problems[0]).toContain('keepOpen');
  });
});

describe('templates', () => {
  it('fills placeholders, leaving unknown ones empty', () => {
    expect(renderTemplate('VOL {level} {nope}', { level: 12 })).toBe('VOL 12 ');
  });

  it('cleans values for where they land, so a name can never add a second command or break a URL or body', () => {
    expect(renderTemplate('P {name}', { name: 'a\r\nPOWER OFF' }, escapeLine)).toBe('P aPOWER OFF');
    expect(renderTemplate('/scene/{name}', { name: '../../admin?x=1 2' }, escapePath)).toBe('/scene/..%2F..%2Fadmin%3Fx%3D1%202');
    expect(renderTemplate('{"n":"{name}"}', { name: 'a"},"evil":"b' }, escapeJson)).toBe('{"n":"a\\"},\\"evil\\":\\"b"}');
    expect(JSON.parse(renderTemplate('{"n":"{name}"}', { name: 'a"},"evil":"b' }, escapeJson))).toEqual({ n: 'a"},"evil":"b' });
  });

  it('scales volume to the device range and reads port numbers', () => {
    const spec = DriverSpec.parse(projector());
    expect(commandValues(spec, {}, { level: 50 }).level).toBe(-20);
    expect(commandValues(spec, {}, { level: 0 }).level).toBe(-40);
    expect(commandValues(spec, { password: 'pw' }, { input: 'in2', output: 'out3' })).toMatchObject({
      inputNumber: '2',
      outputNumber: '3',
      'setting.password': 'pw',
    });
  });

  it('works out a device’s settings from what it set and the defaults, and reports what is missing', () => {
    const spec = DriverSpec.parse({
      ...projector(),
      settings: [
        { key: 'password', label: 'Password', type: 'secret', required: true },
        { key: 'port', label: 'Port', type: 'number', default: 4352 },
      ],
    });
    expect(resolveSettings(spec, { host: '10.0.0.4', password: 'pw' })).toEqual({ values: { host: '10.0.0.4', password: 'pw', port: 4352 }, missing: [] });
    expect(resolveSettings(spec, {}).missing).toEqual(['Password', 'Address']);
    expect(resolveSettings(spec, { host: 'h', password: 5 }).missing).toEqual(['Password']);
  });
});

describe('driver grouping and transports', () => {
  it('takes a make, a model and the categories the driver suits', () => {
    const r = checkDriverSpec({
      ...projector(),
      make: 'Acme',
      model: 'P1',
      categories: ['projector', 'display'],
    });
    expect(r.ok).toBe(true);
  });

  it('suits any network device, not only AV categories', () => {
    for (const c of ['network_switch', 'wireless_ap', 'router_firewall', 'ups', 'nas', 'network_device'])
      expect(checkDriverSpec({ ...projector(), categories: [c] }).ok, c).toBe(true);
    expect(checkDriverSpec({ ...projector(), categories: ['toaster'] }).ok).toBe(false);
    expect(checkDriverSpec({ ...projector(), categories: [] }).ok).toBe(false);
  });

  it('accepts a UDP driver that sends text', () => {
    const r = checkDriverSpec({
      id: 'udp-thing',
      name: 'UDP thing',
      transport: { type: 'udp', port: 7000 },
      commands: { 'power.on': { send: 'ON' }, 'power.off': { send: 'OFF' } },
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.spec.transport.type === 'udp') expect(r.spec.transport.terminator).toBe('');
  });

  it('accepts a WebSocket driver that sends text, and keeps HTTP fields off it', () => {
    const ws = {
      id: 'ws-thing',
      name: 'WS thing',
      transport: { type: 'websocket', port: 8080, path: '/api', secure: true },
      commands: { 'power.on': { send: '{"power":true}' }, 'power.off': { send: '{"power":false}' } },
    };
    expect(checkDriverSpec(ws).ok).toBe(true);
    const bad = checkDriverSpec({ ...ws, commands: { 'power.on': { path: '/on' } } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems.join(' ')).toContain('WebSocket driver needs "send"');
  });

  it('a UDP command needs send, and UDP feedback patterns need something to poll', () => {
    const udp = {
      id: 'udp-thing',
      name: 'UDP thing',
      transport: { type: 'udp' },
      commands: { 'power.on': { send: 'ON' } },
    };
    const noSend = checkDriverSpec({ ...udp, commands: { 'power.on': { path: '/x' } } });
    expect(noSend.ok).toBe(false);
    const patterns = checkDriverSpec({
      ...udp,
      feedback: { poll: [], patterns: [{ match: '^ON', set: 'power', value: 'on' }] },
    });
    expect(patterns.ok).toBe(false);
    if (!patterns.ok) expect(patterns.problems.join(' ')).toContain('UDP');
  });
});
