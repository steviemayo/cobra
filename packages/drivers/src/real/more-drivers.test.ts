import http from 'node:http';
import { createSocket, type Socket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, type Device } from '@kestrel/model';
import { createDriver } from './registry';
import { genericRestDriver } from './generic-rest';
import { SerialDriver, type SerialLike, type SerialOpener } from './serial';
import { ViscaDriver } from './visca';
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
const device = (id: string, control: Device['control'], settings: Record<string, unknown>): Device => ({
  ...base.devices.find((d) => d.id === id)!,
  control,
  settings,
});

// ---- Serial -----------------------------------------------------------------------------------

function fakeSerial() {
  const written: string[] = [];
  const handlers: Record<string, ((a?: unknown) => void)[]> = {};
  const port: SerialLike & { emit: (chunk: string) => void; drop: () => void } = {
    isOpen: true,
    write(data, cb) {
      written.push(data);
      cb?.();
      // The device answers each command line.
      setTimeout(() => port.emit(data.startsWith('BAD') ? 'ERR\r' : 'OK\r'), 5);
      return true;
    },
    on: ((event: string, cb: (a?: never) => void) => {
      (handlers[event] ??= []).push(cb as (a?: unknown) => void);
      return port;
    }) as SerialLike['on'],
    close(cb) {
      port.isOpen = false;
      cb?.();
    },
    emit: (chunk) => handlers.data?.forEach((h) => h(Buffer.from(chunk))),
    drop: () => {
      port.isOpen = false;
      handlers.close?.forEach((h) => h());
    },
  };
  return { port, written };
}

describe('generic serial driver', () => {
  const settings = { path: 'COM3', baudRate: 19200, expect: '^OK$', timeoutMs: 300, commands: { 'power.on': 'PWR ON', 'power.off': 'PWR OFF', volume: 'VOL {level}', preset: 'BAD {name}' } };
  const make = (opener: SerialOpener) => {
    const d = new SerialDriver(device('dsp', { kind: 'generic', protocol: 'serial' }, settings), ctx, opener);
    drivers.push(d);
    return d;
  };

  it('opens the port with its settings, sends terminated commands and waits for the reply', async () => {
    const f = fakeSerial();
    let opts: Parameters<SerialOpener>[0] | null = null;
    const d = make(async (o) => {
      opts = o;
      return f.port;
    });
    d.start();
    await until(() => d.getState().online);
    expect(opts).toMatchObject({ path: 'COM3', baudRate: 19200, dataBits: 8, stopBits: 1, parity: 'none' });
    await d.send({ type: 'power', on: true });
    await d.send({ type: 'volume', level: 40 });
    expect(f.written).toEqual(['PWR ON\r', 'VOL 40\r']);
    expect(d.getState()).toMatchObject({ power: 'on', volume: 40 });
  });

  it('cannot be tricked into sending a second command, and fails on a wrong reply or a missing command', async () => {
    const f = fakeSerial();
    const d = make(async () => f.port);
    d.start();
    await until(() => d.getState().online);
    await expect(d.send({ type: 'preset', name: 'x\rPWR OFF' })).rejects.toThrow('did not respond');
    expect(f.written.at(-1)).toBe('BAD xPWR OFF\r');
    await expect(d.send({ type: 'mute', muted: true })).rejects.toThrow('no "mute.on" command configured');
  });

  it('stays offline and keeps trying when the port cannot be opened, and comes back after a drop', async () => {
    let attempts = 0;
    const f = fakeSerial();
    const d = make(async () => {
      attempts++;
      if (attempts === 1) throw new Error('Access denied');
      return f.port;
    });
    d.start();
    await wait(100);
    expect(d.getState().online).toBe(false);
    await until(() => d.getState().online, 4000);
    f.port.drop();
    await until(() => !d.getState().online);
    await expect(d.send({ type: 'power', on: true })).rejects.toThrow('not open');
  }, 15_000);

  it('does nothing without a port path', () => {
    const d = new SerialDriver(device('dsp', { kind: 'generic', protocol: 'serial' }, {}), ctx, async () => fakeSerial().port);
    drivers.push(d);
    d.start();
    expect(d.getState().online).toBe(false);
  });

  it('is what a generic serial device gets', () => {
    expect(createDriver(device('dsp', { kind: 'generic', protocol: 'serial' }, settings), ctx)).toBeInstanceOf(SerialDriver);
  });
});

// ---- Generic REST -----------------------------------------------------------------------------

describe('generic REST driver', () => {
  it('is built from the device’s own settings, with the same escaping as any driver', async () => {
    const log: { method: string; url: string; body: string; auth?: string }[] = [];
    const state = { on: false };
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        log.push({ method: req.method!, url: req.url!, body, auth: req.headers.authorization });
        if (req.url === '/api/power') state.on = (JSON.parse(body) as { on: boolean }).on;
        res.writeHead(200);
        res.end(req.url === '/api/state' ? JSON.stringify(state) : '{"result":"ok"}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => {
      server.closeAllConnections();
      server.close();
    });
    const settings = {
      host: '127.0.0.1',
      port: (server.address() as { port: number }).port,
      headers: { authorization: 'Bearer abc' },
      commands: {
        'power.on': { method: 'POST', path: '/api/power', body: '{"on":true}', expect: 'ok' },
        'power.off': { method: 'POST', path: '/api/power', body: '{"on":false}', expect: 'ok' },
        scene: { method: 'POST', path: '/api/scene/{name}' },
      },
      poll: { path: '/api/state', everyMs: 1000, patterns: [{ match: '"on":(true|false)', set: 'power', value: '$1' }] },
    };
    const d = genericRestDriver(device('dsp', { kind: 'generic', protocol: 'rest' }, settings), ctx)!;
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    await until(() => d.getState().power === 'off');
    await d.send({ type: 'power', on: true });
    expect(state.on).toBe(true);
    expect(d.getState().power).toBe('on');
    expect(log.find((l) => l.method === 'POST')!.auth).toBe('Bearer abc');
    await d.send({ type: 'scene', name: 'a/../b' });
    expect(log.some((l) => l.url === '/api/scene/a%2F..%2Fb')).toBe(true);
    expect(createDriver(device('dsp', { kind: 'generic', protocol: 'rest' }, settings), ctx)).not.toBeNull();
  });

  it('says why when the settings are not a usable driver', () => {
    const bad = device('dsp', { kind: 'generic', protocol: 'rest' }, { host: 'h', commands: { 'power.on': { method: 'DELETE', path: '/x' } } });
    expect(genericRestDriver(bad, ctx)).toBeNull();
  });
});

// ---- VISCA over IP ----------------------------------------------------------------------------

interface Camera {
  port: number;
  received: number[][];
  power: 'on' | 'off';
  reject: boolean;
  socket: Socket;
}
async function fakeCamera(): Promise<Camera> {
  const socket = createSocket('udp4');
  const cam: Camera = { port: 0, received: [], power: 'off', reject: false, socket };
  socket.on('message', (msg, rinfo) => {
    const type = msg.readUInt16BE(0);
    const seq = msg.readUInt32BE(4);
    const payload = [...msg.subarray(8)];
    const reply = (t: number, bytes: number[]) => {
      const b = Buffer.alloc(8 + bytes.length);
      b.writeUInt16BE(t, 0);
      b.writeUInt16BE(bytes.length, 2);
      b.writeUInt32BE(seq, 4);
      Buffer.from(bytes).copy(b, 8);
      socket.send(b, rinfo.port, rinfo.address);
    };
    if (type === 0x0200) return void reply(0x0201, [0x01]);
    cam.received.push(payload);
    if (type === 0x0110) return void reply(0x0111, [0x90, 0x50, cam.power === 'on' ? 0x02 : 0x03, 0xff]);
    if (cam.reject) return void reply(0x0111, [0x90, 0x60, 0x02, 0xff]);
    if (payload[3] === 0x00) cam.power = payload[4] === 0x02 ? 'on' : 'off';
    reply(0x0111, [0x90, 0x41, 0xff]);
    reply(0x0111, [0x90, 0x51, 0xff]);
  });
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  cam.port = socket.address().port;
  closers.push(() => socket.close());
  return cam;
}

describe('VISCA over IP camera driver', () => {
  const make = (cam: Camera, extra: Record<string, unknown> = {}) => {
    const d = new ViscaDriver(
      device('dsp', { kind: 'driver', driverId: 'visca-ip' }, { host: '127.0.0.1', port: cam.port, timeoutMs: 400, pollMs: 200, presets: { Wide: 0, Podium: 3 }, ...extra }),
      ctx,
    );
    drivers.push(d);
    return d;
  };

  it('comes online by asking the camera whether it is on', async () => {
    const cam = await fakeCamera();
    cam.power = 'on';
    const d = make(cam);
    d.start();
    await until(() => d.getState().online);
    expect(d.getState().power).toBe('on');
  });

  it('recalls presets by name or number, and switches power', async () => {
    const cam = await fakeCamera();
    const d = make(cam);
    d.start();
    await until(() => d.getState().online);
    await d.send({ type: 'camera_preset', name: 'Podium' });
    expect(cam.received.find((p) => p[3] === 0x3f)).toEqual([0x81, 0x01, 0x04, 0x3f, 0x02, 0x03, 0xff]);
    expect(d.getState().preset).toBe('Podium');
    await d.send({ type: 'camera_preset', name: '12' });
    expect(cam.received.filter((p) => p[3] === 0x3f).at(-1)![5]).toBe(12);
    await d.send({ type: 'power', on: true });
    expect(cam.power).toBe('on');
    await d.send({ type: 'power', on: false });
    expect(cam.power).toBe('off');
  });

  it('refuses presets it does not know, commands it does not support, and errors the camera reports', async () => {
    const cam = await fakeCamera();
    const d = make(cam);
    d.start();
    await until(() => d.getState().online);
    await expect(d.send({ type: 'camera_preset', name: 'Nowhere' })).rejects.toThrow('unknown camera preset');
    await expect(d.send({ type: 'camera_preset', name: '999' })).rejects.toThrow('unknown camera preset');
    await expect(d.send({ type: 'volume', level: 5 })).rejects.toThrow('does not support');
    cam.reject = true;
    await expect(d.send({ type: 'camera_preset', name: 'Wide' })).rejects.toThrow('refused the command');
  });

  it('is offline when the camera does not answer', async () => {
    const cam = await fakeCamera();
    const port = cam.port;
    cam.socket.close();
    closers.pop();
    const d = new ViscaDriver(device('dsp', { kind: 'driver', driverId: 'visca-ip' }, { host: '127.0.0.1', port, timeoutMs: 200, pollMs: 300 }), ctx);
    drivers.push(d);
    d.start();
    await wait(500);
    expect(d.getState().online).toBe(false);
    await expect(d.send({ type: 'power', on: true })).rejects.toThrow();
  });
});
