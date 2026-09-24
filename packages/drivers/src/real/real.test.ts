import { createHash } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, type Device, type DeviceEvent } from '@kestrel/model';
import { createSimulation } from '../sim/simulation';
import { GenericTcpDriver } from './generic-tcp';
import { HybridBus } from './hybrid-bus';
import { PjlinkDriver } from './pjlink';
import { createDriver } from './registry';
import type { DeviceDriver, DriverContext } from './types';

const ctx: DriverContext = { log: () => undefined };
const model = STARTER_TEMPLATES[0]!.model;
const display = (settings: Record<string, unknown>): Device => ({
  ...model.devices.find((d) => d.id === 'display1')!,
  control: { kind: 'generic', protocol: 'pjlink' },
  settings,
});

const servers: Server[] = [];
const drivers: DeviceDriver[] = [];
afterEach(() => {
  drivers.splice(0).forEach((d) => d.close());
  servers.splice(0).forEach((s) => s.close());
});

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await wait(15);
  }
}

// ---- Mock PJLink projector -----------------------------------------------------------------

async function pjlink(opts: { password?: string; warmMs?: number; power?: string; input?: string } = {}) {
  const state = { power: opts.power ?? '0', input: opts.input ?? '31' };
  const received: string[] = [];
  const salt = 'a1b2c3d4';
  const port = await listen(
    createServer((socket: Socket) => {
      socket.write(opts.password ? `PJLINK 1 ${salt}\r` : 'PJLINK 0\r');
      let buf = '';
      socket.on('error', () => undefined);
      socket.on('data', (d) => {
        buf += d.toString('latin1');
        let i: number;
        while ((i = buf.indexOf('\r')) >= 0) {
          let line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (opts.password) {
            const digest = createHash('md5').update(salt + opts.password).digest('hex');
            if (!line.startsWith(digest)) {
              socket.end('PJLINK ERRA\r');
              return;
            }
            line = line.slice(32);
          }
          received.push(line);
          const [cmd, arg] = line.slice(2).split(' ');
          if (cmd === 'POWR' && arg === '?') socket.end(`%1POWR=${state.power}\r`);
          else if (cmd === 'INPT' && arg === '?') socket.end(`%1INPT=${state.input}\r`);
          else if (cmd === 'POWR') {
            if (arg === '1') {
              state.power = '3';
              setTimeout(() => (state.power = '1'), opts.warmMs ?? 100);
            } else state.power = '2';
            socket.end('%1POWR=OK\r');
          } else if (cmd === 'INPT') {
            state.input = arg!;
            socket.end('%1INPT=OK\r');
          } else socket.end(`%1${cmd}=ERR1\r`);
        }
      });
    }),
  );
  return { port, state, received };
}

describe('PJLink driver', () => {
  it('turns on, reports warming, and is only ready once the display is on', async () => {
    const p = await pjlink({ warmMs: 250 });
    const d = new PjlinkDriver(display({ host: '127.0.0.1', port: p.port }), ctx);
    drivers.push(d);
    const seen: string[] = [];
    d.onChange((s) => seen.push(String(s.power)));
    const started = Date.now();
    await d.send({ type: 'power', on: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(d.getState()).toMatchObject({ power: 'on', online: true });
    expect(seen).toContain('warming');
    expect(p.received).toContain('%1POWR 1');
  });

  it('selects an input using the default HDMI code, or a configured one', async () => {
    const p = await pjlink({ power: '1' });
    const a = new PjlinkDriver(display({ host: '127.0.0.1', port: p.port }), ctx);
    drivers.push(a);
    await a.send({ type: 'select_input', portId: 'in' });
    expect(p.received).toContain('%1INPT 31');
    expect(a.getState().selectedInput).toBe('in');

    const b = new PjlinkDriver(display({ host: '127.0.0.1', port: p.port, inputs: { in: '32' } }), ctx);
    drivers.push(b);
    await b.send({ type: 'select_input', portId: 'in' });
    expect(p.received).toContain('%1INPT 32');
  });

  it('turning off is accepted immediately and tracked while it cools down', async () => {
    const p = await pjlink({ power: '1' });
    const d = new PjlinkDriver(display({ host: '127.0.0.1', port: p.port }), ctx);
    drivers.push(d);
    await d.send({ type: 'power', on: false });
    expect(d.getState().power).toBe('cooling');
    expect(p.received).toContain('%1POWR 0');
  });

  it('authenticates with the MD5 digest when a password is required', async () => {
    const p = await pjlink({ password: 'secret', power: '1' });
    const ok = new PjlinkDriver(display({ host: '127.0.0.1', port: p.port, password: 'secret' }), ctx);
    drivers.push(ok);
    await ok.send({ type: 'select_input', portId: 'in' });
    expect(ok.getState().online).toBe(true);

    const bad = new PjlinkDriver(display({ host: '127.0.0.1', port: p.port, password: 'nope' }), ctx);
    drivers.push(bad);
    await expect(bad.send({ type: 'select_input', portId: 'in' })).rejects.toThrow();
  });

  it('fails with the device name when it cannot be reached', async () => {
    const p = await pjlink();
    servers.at(-1)!.close();
    const d = new PjlinkDriver(display({ host: '127.0.0.1', port: p.port }), ctx);
    drivers.push(d);
    await expect(d.send({ type: 'power', on: true })).rejects.toThrow(/Display 1/);
  });

  it('fails clearly when no host is configured or a command is unsupported', async () => {
    const d = new PjlinkDriver(display({}), ctx);
    drivers.push(d);
    await expect(d.send({ type: 'power', on: true })).rejects.toThrow('no host configured');
    await expect(d.send({ type: 'volume', level: 5 })).rejects.toThrow("doesn't support volume");
  });

  it('polling picks up changes made at the device itself', async () => {
    const p = await pjlink({ power: '0' });
    const d = new PjlinkDriver(display({ host: '127.0.0.1', port: p.port, pollMs: 40 }), ctx);
    drivers.push(d);
    const events: DeviceEvent[] = [];
    d.onChange((state) => events.push({ deviceId: d.deviceId, state }));
    d.start();
    await until(() => d.getState().online);
    p.state.power = '1';
    await until(() => d.getState().power === 'on');
    expect(events.at(-1)!.state.power).toBe('on');
    p.state.power = '0';
    await until(() => d.getState().power === 'off');
  });
});

// ---- Mock generic TCP device ---------------------------------------------------------------

async function tcpDevice(reply?: string) {
  const received: string[] = [];
  const port = await listen(
    createServer((socket) => {
      socket.on('error', () => undefined);
      socket.on('data', (d) => {
        received.push(d.toString());
        if (reply) socket.write(reply);
      });
    }),
  );
  return { port, received };
}

const dsp = (settings: Record<string, unknown>): Device => ({
  ...model.devices.find((d) => d.id === 'dsp')!,
  control: { kind: 'generic', protocol: 'tcp' },
  settings,
});

describe('generic TCP driver', () => {
  const commands = {
    'power.on': 'PWR ON',
    'mute.on': 'MUTE 1',
    'mute.off': 'MUTE 0',
    volume: 'VOL {level}',
    route: 'SW I{input} O{output}',
    preset: 'PRESET {name}',
    'command.ping': 'PING',
  };

  it('sends the configured command text with the terminator, and mirrors state', async () => {
    const dev = await tcpDevice();
    const d = new GenericTcpDriver(dsp({ host: '127.0.0.1', port: dev.port, commands, terminator: '\r' }), ctx);
    drivers.push(d);
    await d.send({ type: 'volume', level: 65 });
    await d.send({ type: 'mute', muted: true });
    await d.send({ type: 'route', inputPortId: 'in2', outputPortId: 'out3' });
    await d.send({ type: 'preset', name: 'Lecture' });
    await d.send({ type: 'command', name: 'ping', args: {} });
    await until(() => dev.received.join('').includes('PING'));
    expect(dev.received.join('')).toBe('VOL 65\rMUTE 1\rSW I2 O3\rPRESET Lecture\rPING\r');
    expect(d.getState()).toMatchObject({
      online: true,
      volume: 65,
      muted: true,
      preset: 'Lecture',
      routes: { out3: 'in2' },
    });
  });

  it('refuses a command that has no template, naming what is missing', async () => {
    const dev = await tcpDevice();
    const d = new GenericTcpDriver(dsp({ host: '127.0.0.1', port: dev.port, commands }), ctx);
    drivers.push(d);
    await expect(d.send({ type: 'power', on: false })).rejects.toThrow('no "power.off" command configured');
  });

  it('waits for an expected reply and fails if it never comes', async () => {
    const ok = await tcpDevice('OK\r\n');
    const a = new GenericTcpDriver(dsp({ host: '127.0.0.1', port: ok.port, commands, expect: 'OK' }), ctx);
    drivers.push(a);
    await a.send({ type: 'power', on: true });
    expect(a.getState().power).toBe('on');

    const silent = await tcpDevice();
    const b = new GenericTcpDriver(
      dsp({ host: '127.0.0.1', port: silent.port, commands, expect: 'OK', timeoutMs: 150 }),
      ctx,
    );
    drivers.push(b);
    await expect(b.send({ type: 'power', on: true })).rejects.toThrow('did not respond');
    expect(b.getState().online).toBe(false);
    expect(b.getState().power).toBeUndefined();
  });

  it('reports the device offline when it cannot connect', async () => {
    const dev = await tcpDevice();
    servers.at(-1)!.close();
    const d = new GenericTcpDriver(dsp({ host: '127.0.0.1', port: dev.port, commands }), ctx);
    drivers.push(d);
    await expect(d.send({ type: 'power', on: true })).rejects.toThrow();
    expect(d.getState().online).toBe(false);
  });
});

describe('createDriver', () => {
  it('picks a driver from the device control setting', () => {
    expect(createDriver(display({}), ctx)).toBeInstanceOf(PjlinkDriver);
    expect(createDriver(dsp({}), ctx)).toBeInstanceOf(GenericTcpDriver);
  });

  it('returns null for devices with no control, or with a driver that is not built yet', () => {
    const laptop = model.devices.find((d) => d.id === 'laptop1')!;
    expect(createDriver(laptop, ctx)).toBeNull();
    expect(createDriver(model.devices.find((d) => d.id === 'matrix')!, ctx)).toBeNull();
    expect(createDriver({ ...dsp({}), control: { kind: 'generic', protocol: 'serial' } }, ctx)).toBeNull();
  });
});

describe('HybridBus', () => {
  it('sends to real hardware where a driver exists, and to the simulator for the rest', async () => {
    const p = await pjlink({ warmMs: 50 });
    const real = new PjlinkDriver(display({ host: '127.0.0.1', port: p.port }), ctx);
    const sim = createSimulation(model, { latencyScale: 0 });
    const bus = new HybridBus(new Map([['display1', real]]), sim);
    drivers.push(real);

    await bus.send('display1', { type: 'power', on: true });
    expect(p.received).toContain('%1POWR 1');
    expect(bus.getState('display1')!.power).toBe('on'); // real
    expect(sim.getState('display1')!.power).toBe('off'); // the sim copy was never touched

    await bus.send('matrix', { type: 'route', inputPortId: 'in1', outputPortId: 'out1' });
    expect(bus.getState('matrix')!.routes.out1).toBe('in1'); // simulated
    bus.close();
  });

  it('merges events from real and simulated devices, and hides the sim copy of real devices', async () => {
    const p = await pjlink({ warmMs: 50 });
    const real = new PjlinkDriver(display({ host: '127.0.0.1', port: p.port }), ctx);
    const sim = createSimulation(model, { latencyScale: 0 });
    const bus = new HybridBus(new Map([['display1', real]]), sim);
    drivers.push(real);
    const ids: string[] = [];
    bus.subscribe((e) => ids.push(e.deviceId));
    await sim.send('display1', { type: 'power', on: true }); // sim-side change to a real device: ignored
    expect(ids).not.toContain('display1');
    sim.plug('laptop1', true);
    expect(ids).toContain('matrix');
    await real.send({ type: 'power', on: true });
    expect(ids).toContain('display1');
    bus.close();
  });

  it('rejects commands for a device with no driver and no simulator', async () => {
    const bus = new HybridBus(new Map(), null);
    await expect(bus.send('matrix', { type: 'power', on: true })).rejects.toThrow('No driver available');
    expect(bus.getState('matrix')).toBeUndefined();
  });
});
