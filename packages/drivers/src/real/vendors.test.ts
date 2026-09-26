import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILT_IN_DRIVERS,
  CLASS_CONTRACT,
  DRIVER_CLASSES,
  STARTER_TEMPLATES,
  classProblems,
  type Device,
} from '@kestrel/model';
import { LIBRARY } from '../library';
import { createDriver } from './registry';
import type { DeviceDriver, DriverContext } from './types';

const ctx: DriverContext = { log: () => undefined };
const base = STARTER_TEMPLATES[0]!.model;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await wait(10);
  }
}

const servers: Server[] = [];
const drivers: DeviceDriver[] = [];
afterEach(() => {
  drivers.splice(0).forEach((d) => d.close());
  servers.splice(0).forEach((s) => s.close());
});

/** A TCP device: records the raw bytes it gets and answers each command with `reply`. */
async function fakeDevice(reply: (line: string) => string | null, terminator = '\r') {
  const received: string[] = [];
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.setEncoding('latin1');
    socket.on('error', () => undefined);
    let buf = '';
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf(terminator)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + terminator.length);
        received.push(line);
        const out = reply(line);
        if (out !== null) socket.write(out);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as { port: number }).port, received, sockets };
}

const start = (category: Device['category'], driverId: string, settings: Record<string, unknown>) => {
  const device: Device = {
    ...base.devices.find((d) => d.id === (category === 'video_matrix' ? 'matrix' : 'display1'))!,
    control: { kind: 'driver', driverId },
    settings,
  };
  const driver = createDriver(device, ctx)!;
  drivers.push(driver);
  driver.start();
  return driver;
};

// ---- LG signage ----------------------------------------------------------------------------------

describe('LG signage driver', () => {
  /** A display that is on, muted and not blanked, answering the way LG does (ended by "x"). */
  const lg = () => {
    const state = { power: '01', mute: '00', blank: '00' };
    return fakeDevice((line) => {
      const m = /^(k[aedf]|xb) (\d+) ([0-9A-F]{2})$/.exec(line);
      if (!m) return 'NG';
      const [, cmd, id, data] = m as unknown as [string, string, string, string];
      const ack = (c: string, v: string) => `${c} ${id} OK${v}x`;
      if (cmd === 'ka') return ack('a', data === 'FF' ? state.power : (state.power = data));
      if (cmd === 'ke') return ack('e', data === 'FF' ? state.mute : (state.mute = data));
      if (cmd === 'kd') return ack('d', data === 'FF' ? state.blank : (state.blank = data));
      return ack(cmd.slice(1), data);
    });
  };
  const settings = (port: number) => ({ host: '127.0.0.1', port, timeoutMs: 800 });

  it('sends each command the way LG describes it, ended by CR', async () => {
    const dev = await lg();
    const d = start('display', 'lib:lg-signage', settings(dev.port));
    await until(() => d.getState().online);
    dev.received.length = 0;
    await d.send({ type: 'power', on: true });
    await d.send({ type: 'power', on: false });
    await d.send({ type: 'select_input', portId: 'in1' });
    await d.send({ type: 'select_input', portId: 'in2' });
    await d.send({ type: 'volume', level: 50 });
    await d.send({ type: 'volume', level: 100 });
    await d.send({ type: 'volume', level: 7 });
    await d.send({ type: 'mute', muted: true });
    await d.send({ type: 'mute', muted: false });
    await d.send({ type: 'blank', on: true });
    await d.send({ type: 'blank', on: false });
    await until(() => dev.received.filter((l) => !l.endsWith(' FF')).length >= 11);
    expect(dev.received.filter((l) => !l.endsWith(' FF'))).toEqual([
      'ka 01 01',
      'ka 01 00',
      'xb 01 90',
      'xb 01 91',
      'kf 01 32',
      'kf 01 64',
      'kf 01 07',
      'ke 01 00',
      'ke 01 01',
      'kd 01 01',
      'kd 01 00',
    ]);
  });

  it('uses the Set ID it is given', async () => {
    const dev = await lg();
    const d = start('display', 'lib:lg-signage', { ...settings(dev.port), setId: '05' });
    await d.send({ type: 'power', on: true });
    await until(() => dev.received.includes('ka 05 01'));
    expect(dev.received).toContain('ka 05 01');
  });

  it('reads power, mute and blank from replies that end in "x", not CR', async () => {
    const dev = await lg();
    const d = start('display', 'lib:lg-signage', settings(dev.port));
    await until(() => d.getState().power === 'on' && d.getState().muted === true && d.getState().blanked === false);
    await d.send({ type: 'mute', muted: false });
    await d.send({ type: 'blank', on: true });
    await until(() => d.getState().muted === false && d.getState().blanked === true);
  });

  it('declares a blank quick action and the built-in audio, and no remote keys', () => {
    const spec = LIBRARY['lib:lg-signage']!;
    expect(spec.quickActions).toEqual(['display.blank']);
    expect(spec.features).toEqual(['blank', 'builtin_audio']);
  });
});

// ---- Kramer Protocol 3000 -----------------------------------------------------------------------

describe('Kramer Protocol 3000 driver', () => {
  const kramer = (fail = false) =>
    fakeDevice((line) => {
      const m = /^#ROUTE (\d+),(\d+),(\d+)$/.exec(line);
      if (m) return fail ? '~01@ROUTE ERR 002\r\n' : `~01@ROUTE ${m[1]},${m[2]},${m[3]}\r\n`;
      if (line.startsWith('#ROUTE?')) return '~01@ROUTE 1,1,1\r\n';
      return '~01@ERR 001\r\n';
    });

  it('routes video with #ROUTE layer,dest,src, ended by CR, and waits for its reply', async () => {
    const dev = await kramer();
    const d = start('video_matrix', 'lib:kramer-p3000', { host: '127.0.0.1', port: dev.port });
    await until(() => d.getState().online);
    await d.send({ type: 'route', inputPortId: 'in2', outputPortId: 'out3' });
    expect(dev.received).toContain('#ROUTE 1,3,2');
    expect(d.getState().routes.out3).toBe('in2');
  });

  it('fails the route when the switcher answers with an error', async () => {
    const dev = await kramer(true);
    const d = start('video_matrix', 'lib:kramer-p3000', { host: '127.0.0.1', port: dev.port, timeoutMs: 300 });
    await until(() => d.getState().online);
    await expect(d.send({ type: 'route', inputPortId: 'in1', outputPortId: 'out1' })).rejects.toThrow();
    expect(d.getState().routes.out1).toBeUndefined();
  });
});

// ---- The class contract --------------------------------------------------------------------------

describe('every bundled declarative driver meets the contract of its class', () => {
  it('has the commands its class needs and each feature it declares needs', () => {
    for (const [id, spec] of Object.entries(LIBRARY))
      expect(classProblems(spec.class, spec.features, Object.keys(spec.commands)), id).toEqual([]);
  });

  it('is listed in the device editor with the same class and features', () => {
    for (const [id, spec] of Object.entries(LIBRARY)) {
      expect(BUILT_IN_DRIVERS[id]?.class, id).toBe(spec.class);
      expect([...(BUILT_IN_DRIVERS[id]?.features ?? [])].sort(), id).toEqual([...(spec.features ?? [])].sort());
    }
  });

  it('names only features that exist, for every class that has a contract', () => {
    for (const [cls, contract] of Object.entries(CLASS_CONTRACT))
      for (const feature of Object.keys(contract!.features))
        expect(feature in DRIVER_CLASSES[cls as keyof typeof DRIVER_CLASSES].features, `${cls}:${feature}`).toBe(true);
  });
});
