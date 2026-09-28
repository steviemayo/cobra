import http from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DriverSpec, STARTER_TEMPLATES, type Device, type PinnedDriver } from '@kestrel/model';
import { DeclarativeDriver } from './declarative';
import { createDriver } from './registry';
import type { DeviceDriver, DriverContext } from './types';

const ctx: DriverContext = { log: () => undefined };
const base = STARTER_TEMPLATES[0]!.model;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await wait(15);
  }
}

const closers: (() => void)[] = [];
const drivers: DeviceDriver[] = [];
afterEach(() => {
  drivers.splice(0).forEach((d) => d.close());
  closers.splice(0).forEach((c) => c());
});

const dev = (settings: Record<string, unknown>): Device => ({
  ...base.devices.find((d) => d.id === 'dsp')!,
  control: { kind: 'driver', driverId: 'custom:acme-amp' },
  settings,
});
const make = (spec: unknown, settings: Record<string, unknown>) => {
  const d = new DeclarativeDriver(dev(settings), ctx, DriverSpec.parse(spec));
  drivers.push(d);
  return d;
};

// ---- TCP --------------------------------------------------------------------------------------

interface TcpFake {
  port: number;
  received: string[];
  clients: Socket[];
  state: { power: string; vol: number };
}
async function fakeTcp(): Promise<TcpFake> {
  const received: string[] = [];
  const clients: Socket[] = [];
  const state = { power: 'OFF', vol: -20 };
  const server: Server = createServer((s) => {
    clients.push(s);
    s.setEncoding('utf8');
    let buf = '';
    s.on('error', () => undefined);
    s.on('data', (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        received.push(line);
        if (line === 'PWR ON') {
          state.power = 'ON';
          s.write('OK\r\nPOWER=ON\r\n');
        } else if (line === 'PWR OFF') {
          state.power = 'OFF';
          s.write('OK\r\nPOWER=OFF\r\n');
        } else if (line.startsWith('VOL ')) {
          state.vol = Number(line.slice(4));
          s.write(`VOL=${state.vol}\r\n`);
        } else if (line === 'STATUS?')
          s.write(`POWER=${state.power}\r\nVOL=${state.vol}\r\nFW=2.1.4\r\n`);
        else if (line === 'NOREPLY') return;
        else s.write('ERR\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => {
    clients.forEach((c) => c.destroy());
    server.close();
  });
  return { port: (server.address() as { port: number }).port, received, clients, state };
}

const amp = (keepOpen: boolean) => ({
  id: 'acme-amp',
  name: 'Acme amplifier',
  transport: { type: 'tcp', keepOpen, timeoutMs: 400 },
  commands: {
    'power.on': { send: 'PWR ON', expect: '^OK$' },
    'power.off': { send: 'PWR OFF', expect: '^OK$' },
    volume: { send: 'VOL {level}', expect: '^VOL=' },
    preset: { send: 'PRESET {name}', expect: '^OK$' },
    'command.hang': { send: 'NOREPLY', expect: '^OK$' },
  },
  volumeScale: { min: -40, max: 0 },
  feedback: {
    poll: [{ action: { send: 'STATUS?' }, everyMs: 1000 }],
    patterns: [
      { match: '^POWER=(ON|OFF)$', set: 'power', value: '$1' },
      { match: '^VOL=(-?\\d+)$', set: 'volume', value: '$1' },
    ],
  },
});

describe('firmware from a declarative driver', () => {
  const withFirmware = (keepOpen: boolean) => ({
    ...amp(keepOpen),
    feedback: {
      poll: [{ action: { send: 'STATUS?' }, everyMs: 1000 }],
      patterns: [
        ...amp(keepOpen).feedback.patterns,
        { match: '^FW=(.+)$', set: 'firmware', value: '$1' },
      ],
    },
  });

  it('is read from a pattern that sets it, on a held connection and on one connection per command', async () => {
    for (const keepOpen of [true, false]) {
      const dev = await fakeTcp();
      const d = make(withFirmware(keepOpen), { host: '127.0.0.1', port: dev.port });
      d.start();
      await until(() => d.getState().firmware === '2.1.4');
      expect(d.getState().online).toBe(true);
    }
  });

  it('is left unset by a driver that has no such pattern', async () => {
    const dev = await fakeTcp();
    const d = make(amp(true), { host: '127.0.0.1', port: dev.port });
    d.start();
    await until(() => d.getState().power === 'off');
    expect(d.getState().firmware).toBeUndefined();
  });

  it('is accepted by the driver format', () => {
    expect(DriverSpec.safeParse(withFirmware(true)).success).toBe(true);
  });
});

describe('a feedback or "expect" pattern that could hang the gateway', () => {
  const withBadPattern = {
    ...amp(true),
    feedback: {
      poll: [{ action: { send: 'STATUS?' }, everyMs: 1000 }],
      patterns: [...amp(true).feedback.patterns, { match: '(a+)+$', set: 'firmware', value: '1' }],
    },
  };

  it('is never loaded, but every other feedback pattern still works', async () => {
    const logs: unknown[][] = [];
    const loggingCtx: DriverContext = { log: (...a) => void logs.push(a) };
    const tcp = await fakeTcp();
    const d = new DeclarativeDriver(
      dev({ host: '127.0.0.1', port: tcp.port }),
      loggingCtx,
      DriverSpec.parse(withBadPattern),
    );
    drivers.push(d);
    d.start();
    await until(() => d.getState().power === 'off');
    expect(d.getState().firmware).toBeUndefined();
    expect(logs.some((l) => String(l[1]).includes('could hang the gateway'))).toBe(true);
  });

  it('is never used for a command’s "expect" either', async () => {
    const logs: unknown[][] = [];
    const loggingCtx: DriverContext = { log: (...a) => void logs.push(a) };
    const tcp = await fakeTcp();
    const withBadExpect = { ...amp(true), commands: { ...amp(true).commands, 'power.on': { send: 'PWR ON', expect: '(a+)+$' } } };
    const d = new DeclarativeDriver(
      dev({ host: '127.0.0.1', port: tcp.port }),
      loggingCtx,
      DriverSpec.parse(withBadExpect),
    );
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    // With no safe "expect" to wait for, the command resolves as soon as it is written.
    await d.send({ type: 'power', on: true });
    expect(logs.some((l) => String(l[1]).includes('could hang the gateway'))).toBe(true);
  });
});

describe('a driver over TCP with a held connection', () => {
  it('goes online, reads feedback the device volunteers, and sends scaled values', async () => {
    const dev = await fakeTcp();
    const d = make(amp(true), { host: '127.0.0.1', port: dev.port });
    d.start();
    await until(() => d.getState().online);
    await d.send({ type: 'power', on: true });
    expect(dev.received).toContain('PWR ON');
    await until(() => d.getState().power === 'on');
    await d.send({ type: 'volume', level: 75 });
    expect(dev.received).toContain('VOL -10');
    await until(() => d.getState().volume === 75);
  });

  it('fails a command whose reply never comes, and reconnects after a drop', async () => {
    const dev = await fakeTcp();
    const d = make(amp(true), { host: '127.0.0.1', port: dev.port });
    d.start();
    await until(() => d.getState().online);
    await expect(d.send({ type: 'command', name: 'hang', args: {} })).rejects.toThrow(
      'did not answer',
    );
    dev.clients.forEach((c) => c.destroy());
    await until(() => !d.getState().online);
    await until(() => d.getState().online, 6000);
  }, 15_000);

  it('cannot be tricked into sending a second command by a preset name', async () => {
    const dev = await fakeTcp();
    const d = make(amp(true), { host: '127.0.0.1', port: dev.port });
    d.start();
    await until(() => d.getState().online);
    await d.send({ type: 'preset', name: 'Movie\r\nPWR OFF' }).catch(() => undefined);
    expect(dev.received).toContain('PRESET MoviePWR OFF');
    expect(dev.received).not.toContain('PWR OFF');
  });

  it('says so for a command the driver does not define', async () => {
    const dev = await fakeTcp();
    const d = make(amp(true), { host: '127.0.0.1', port: dev.port });
    d.start();
    await until(() => d.getState().online);
    await expect(d.send({ type: 'mute', muted: true })).rejects.toThrow(
      'does not support "mute.on"',
    );
  });
});

describe('a driver over TCP, one connection per command', () => {
  it('checks the reply, and keeps polling for state', async () => {
    const dev = await fakeTcp();
    const spec = {
      ...amp(false),
      feedback: {
        poll: [{ action: { send: 'STATUS?', expect: '^VOL=' }, everyMs: 1000 }],
        patterns: amp(false).feedback.patterns,
      },
    };
    const d = make(spec, { host: '127.0.0.1', port: dev.port });
    d.start();
    await until(() => d.getState().online);
    await d.send({ type: 'power', on: true });
    expect(dev.state.power).toBe('ON');
    expect(d.getState().power).toBe('on');
    await d.send({ type: 'volume', level: 100 });
    expect(dev.state.vol).toBe(0);
  });

  it('is offline when the device is unreachable, and when settings are missing', async () => {
    const dev = await fakeTcp();
    closers.pop()!();
    const d = make(amp(false), { host: '127.0.0.1', port: dev.port });
    d.start();
    await wait(200);
    expect(d.getState().online).toBe(false);
    await expect(d.send({ type: 'power', on: true })).rejects.toThrow();
    const noHost = make(amp(false), {});
    noHost.start();
    expect(noHost.getState().online).toBe(false);
  });
});

// ---- HTTP -------------------------------------------------------------------------------------

async function fakeHttp() {
  const log: { method: string; url: string; body: string; headers: http.IncomingHttpHeaders }[] =
    [];
  const state = { on: false, level: 30 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      log.push({ method: req.method!, url: req.url!, body, headers: req.headers });
      if (req.headers.authorization !== 'Bearer tok') {
        res.writeHead(401);
        return void res.end('no');
      }
      if (req.url === '/api/state') {
        res.writeHead(200);
        return void res.end(JSON.stringify(state));
      }
      if (req.url === '/api/power' && req.method === 'POST') {
        state.on = (JSON.parse(body) as { on: boolean }).on;
        res.writeHead(200);
        return void res.end('{"result":"ok"}');
      }
      if (req.url!.startsWith('/api/scene/')) {
        res.writeHead(200);
        return void res.end('{"result":"ok"}');
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { port: (server.address() as { port: number }).port, log, state };
}

const lights = {
  id: 'acme-amp',
  name: 'Acme lights',
  transport: { type: 'http', headers: { authorization: 'Bearer {setting.token}' }, timeoutMs: 800 },
  settings: [{ key: 'token', label: 'Token', type: 'secret', required: true }],
  commands: {
    'power.on': { method: 'POST', path: '/api/power', body: '{"on":true}', expect: '"ok"' },
    'power.off': { method: 'POST', path: '/api/power', body: '{"on":false}', expect: '"ok"' },
    scene: { method: 'POST', path: '/api/scene/{name}', expect: '"ok"' },
  },
  feedback: {
    poll: [{ action: { method: 'GET', path: '/api/state' }, everyMs: 1000 }],
    patterns: [{ match: '"on":(true|false)', set: 'power', value: '$1' }],
  },
};

describe('a driver over HTTP', () => {
  it('signs in with a templated header, sends requests, and reads state from replies', async () => {
    const dev = await fakeHttp();
    const d = make(lights, { host: '127.0.0.1', port: dev.port, token: 'tok' });
    d.start();
    await until(() => d.getState().online);
    await until(() => d.getState().power === 'off');
    await d.send({ type: 'power', on: true });
    expect(dev.state.on).toBe(true);
    expect(d.getState().power).toBe('on');
    const post = dev.log.find((l) => l.method === 'POST')!;
    expect(post.headers['content-type']).toBe('application/json');
    expect(post.headers.authorization).toBe('Bearer tok');
  });

  it('keeps a scene name inside its URL segment', async () => {
    const dev = await fakeHttp();
    const d = make(lights, { host: '127.0.0.1', port: dev.port, token: 'tok' });
    d.start();
    await until(() => d.getState().online);
    await d.send({ type: 'scene', name: '../power?x=1' });
    expect(dev.log.some((l) => l.url === '/api/scene/..%2Fpower%3Fx%3D1')).toBe(true);
    expect(dev.log.some((l) => l.method === 'POST' && l.url === '/api/power')).toBe(false);
  });

  it('goes offline when the device refuses the credentials', async () => {
    const dev = await fakeHttp();
    const d = make(lights, { host: '127.0.0.1', port: dev.port, token: 'wrong' });
    d.start();
    await wait(300);
    expect(d.getState().online).toBe(false);
    await expect(d.send({ type: 'power', on: true })).rejects.toThrow('HTTP 401');
  });
});

describe('custom drivers in a release', () => {
  const pinned: Record<string, PinnedDriver> = {
    'custom:acme-amp': { version: 3, spec: DriverSpec.parse(amp(false)) },
  };

  it('is created from the spec pinned in the release, and only from there', () => {
    expect(createDriver(dev({ host: 'h' }), ctx, pinned)).toBeInstanceOf(DeclarativeDriver);
    expect(createDriver(dev({ host: 'h' }), ctx, {})).toBeNull();
    const other = { ...dev({}), control: { kind: 'driver' as const, driverId: 'custom:unknown' } };
    expect(createDriver(other, ctx, pinned)).toBeNull();
  });
});

describe('quick actions in a driver', () => {
  const blanker = {
    ...amp(true),
    quickActions: ['display.blank'],
    commands: {
      ...amp(true).commands,
      'blank.on': { send: 'BLANK ON', expect: '^OK$' },
      'blank.off': { send: 'BLANK OFF', expect: '^OK$' },
    },
  };

  it('reports what the spec declares, and nothing when it declares nothing', () => {
    expect(make(blanker, { host: '127.0.0.1' }).quickActions()).toEqual(['display.blank']);
    expect(make(amp(true), { host: '127.0.0.1' }).quickActions()).toEqual([]);
  });

  it('runs the blank commands and tracks the state, which powering off clears', async () => {
    const dev = await fakeTcp();
    const d = make(blanker, { host: '127.0.0.1', port: dev.port });
    d.start();
    await until(() => d.getState().online);
    // The fake answers "ERR" to commands it does not know, so teach it the two it needs.
    dev.clients.forEach((c) =>
      c.on('data', (b: string) => /BLANK (ON|OFF)/.test(String(b)) && c.write('OK\r\n')),
    );
    await d.send({ type: 'blank', on: true });
    expect(dev.received).toContain('BLANK ON');
    expect(d.getState().blanked).toBe(true);
    await d.send({ type: 'power', on: false });
    expect(d.getState().blanked).toBe(false);
  });

  it('refuses blank when the driver has no such command', async () => {
    const dev = await fakeTcp();
    const d = make(amp(true), { host: '127.0.0.1', port: dev.port });
    d.start();
    await until(() => d.getState().online);
    await expect(d.send({ type: 'blank', on: true })).rejects.toThrow(
      'does not support "blank.on"',
    );
  });
});
