import http from 'node:http';
import { createSocket, type Socket } from 'node:dgram';
import { createServer, type AddressInfo, type Socket as NetSocket } from 'node:net';
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

  it('never runs an "expect" pattern that could hang the gateway', async () => {
    const logs: unknown[][] = [];
    const loggingCtx: DriverContext = { log: (...a) => void logs.push(a) };
    const f = fakeSerial();
    const d = new SerialDriver(
      device('dsp', { kind: 'generic', protocol: 'serial' }, { ...settings, expect: '(a+)+$' }),
      loggingCtx,
      async () => f.port,
    );
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    // With the unsafe pattern never applied there is nothing to wait for, so this resolves at once.
    await d.send({ type: 'power', on: true });
    expect(d.getState().power).toBe('on');
    expect(logs.some((l) => String(l[1]).includes('could hang the gateway'))).toBe(true);
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

interface TcpCamera {
  port: number;
  received: number[][];
  power: 'on' | 'off';
  reject: boolean;
  dropAll: () => void;
  stop: () => Promise<void>;
}
/** A camera over TCP: raw VISCA (messages end in 0xFF) or the 8 byte IP header form. */
async function fakeTcpCamera(framing: 'raw' | 'ip'): Promise<TcpCamera> {
  const clients = new Set<NetSocket>();
  const cam: TcpCamera = {
    port: 0,
    received: [],
    power: 'off',
    reject: false,
    dropAll: () => clients.forEach((c) => c.destroy()),
    stop: () => new Promise<void>((r) => (cam.dropAll(), server.close(() => r()))),
  };
  const server = createServer((c) => {
    clients.add(c);
    c.on('close', () => clients.delete(c));
    c.on('error', () => undefined);
    let rx = Buffer.alloc(0);
    const send = (seq: number, bytes: number[]) => {
      if (framing === 'raw') return void c.write(Buffer.from(bytes));
      const b = Buffer.alloc(8 + bytes.length);
      b.writeUInt16BE(0x0111, 0);
      b.writeUInt16BE(bytes.length, 2);
      b.writeUInt32BE(seq, 4);
      Buffer.from(bytes).copy(b, 8);
      c.write(b);
    };
    const handle = (type: number, seq: number, payload: number[]) => {
      cam.received.push(payload);
      if (type === 0x0110) return send(seq, [0x90, 0x50, cam.power === 'on' ? 0x02 : 0x03, 0xff]);
      if (cam.reject) return send(seq, [0x90, 0x60, 0x02, 0xff]);
      if (payload[3] === 0x00) cam.power = payload[4] === 0x02 ? 'on' : 'off';
      send(seq, [0x90, 0x41, 0xff]);
      // Replies arrive late, and in one chunk with the ACK of the next if the driver sent them together.
      setTimeout(() => send(seq, [0x90, 0x51, 0xff]), 5);
    };
    c.on('data', (chunk: Buffer) => {
      rx = Buffer.concat([rx, chunk]);
      if (framing === 'raw') {
        for (let end = rx.indexOf(0xff); end >= 0; end = rx.indexOf(0xff)) {
          const msg = [...rx.subarray(0, end + 1)];
          rx = rx.subarray(end + 1);
          // Inquiries are 8x 09 ..; everything else is a command.
          handle(msg[1] === 0x09 ? 0x0110 : 0x0100, 0, msg);
        }
        return;
      }
      while (rx.length >= 8 && rx.length >= 8 + rx.readUInt16BE(2)) {
        const len = rx.readUInt16BE(2);
        handle(rx.readUInt16BE(0), rx.readUInt32BE(4), [...rx.subarray(8, 8 + len)]);
        rx = rx.subarray(8 + len);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cam.port = (server.address() as AddressInfo).port;
  closers.push(() => void cam.stop());
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

  it('points the camera: pan, tilt and zoom, and stops', async () => {
    const cam = await fakeCamera();
    const d = make(cam, { panSpeed: 8, tiltSpeed: 6, zoomSpeed: 2 });
    d.start();
    await until(() => d.getState().online);
    await d.send({ type: 'camera_move', pan: -1, tilt: 1, zoom: 1 });
    const drive = () => cam.received.filter((p) => p[2] === 0x06 && p[3] === 0x01).at(-1);
    const zoom = () => cam.received.filter((p) => p[2] === 0x04 && p[3] === 0x07).at(-1);
    // left (01) and up (01), at the set speeds; zoom in (tele) at speed 2
    expect(drive()).toEqual([0x81, 0x01, 0x06, 0x01, 8, 6, 0x01, 0x01, 0xff]);
    expect(zoom()).toEqual([0x81, 0x01, 0x04, 0x07, 0x22, 0xff]);
    await d.send({ type: 'camera_move', pan: 1, tilt: -1, zoom: -1 });
    expect(drive()).toEqual([0x81, 0x01, 0x06, 0x01, 8, 6, 0x02, 0x02, 0xff]);
    expect(zoom()).toEqual([0x81, 0x01, 0x04, 0x07, 0x32, 0xff]);
    await d.send({ type: 'camera_move', pan: 0, tilt: 0, zoom: 0 });
    expect(drive()).toEqual([0x81, 0x01, 0x06, 0x01, 8, 6, 0x03, 0x03, 0xff]);
    expect(zoom()).toEqual([0x81, 0x01, 0x04, 0x07, 0x00, 0xff]);
  });

  it('keeps moving speeds within what a camera accepts', async () => {
    const cam = await fakeCamera();
    const d = make(cam, { panSpeed: 999, tiltSpeed: 0, zoomSpeed: 99 });
    d.start();
    await until(() => d.getState().online);
    await d.send({ type: 'camera_move', pan: 1, tilt: 1, zoom: 1 });
    expect(cam.received.filter((p) => p[2] === 0x06).at(-1)!.slice(4, 6)).toEqual([24, 1]);
    expect(cam.received.filter((p) => p[2] === 0x04 && p[3] === 0x07).at(-1)![4]).toBe(0x27);
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

  describe.each(['raw', 'ip'] as const)('over TCP, %s framing', (framing) => {
    const makeTcp = (cam: TcpCamera, extra: Record<string, unknown> = {}) => {
      const d = new ViscaDriver(
        device('dsp', { kind: 'driver', driverId: 'visca-ip' }, { host: '127.0.0.1', transport: 'tcp', framing, port: cam.port, timeoutMs: 400, pollMs: 200, presets: { Wide: 0, Podium: 3 }, ...extra }),
        ctx,
      );
      drivers.push(d);
      return d;
    };

    it('comes online, recalls presets and switches power', async () => {
      const cam = await fakeTcpCamera(framing);
      cam.power = 'on';
      const d = makeTcp(cam);
      d.start();
      await until(() => d.getState().online);
      expect(d.getState().power).toBe('on');
      await d.send({ type: 'camera_preset', name: 'Podium' });
      expect(cam.received.find((p) => p[3] === 0x3f)).toEqual([0x81, 0x01, 0x04, 0x3f, 0x02, 0x03, 0xff]);
      await d.send({ type: 'power', on: false });
      expect(cam.power).toBe('off');
    });

    it('keeps replies apart when commands are sent together', async () => {
      const cam = await fakeTcpCamera(framing);
      const d = makeTcp(cam);
      d.start();
      await until(() => d.getState().online);
      await Promise.all([
        d.send({ type: 'camera_preset', name: 'Wide' }),
        d.send({ type: 'camera_move', pan: 1, tilt: 0, zoom: -1 }),
        d.send({ type: 'power', on: true }),
      ]);
      expect(cam.received.filter((p) => p[3] === 0x3f)).toHaveLength(1);
      expect(cam.power).toBe('on');
    });

    it('reports an error the camera sends, and reconnects after the connection drops', async () => {
      const cam = await fakeTcpCamera(framing);
      const d = makeTcp(cam);
      d.start();
      await until(() => d.getState().online);
      cam.reject = true;
      await expect(d.send({ type: 'camera_preset', name: 'Wide' })).rejects.toThrow('refused the command');
      cam.reject = false;
      cam.dropAll();
      // The next command (or poll) opens a new connection; the camera is not marked offline for a drop it recovers from.
      await wait(50);
      await d.send({ type: 'camera_preset', name: 'Wide' });
      expect(d.getState().online).toBe(true);
    });

    it('is offline when nothing is listening', async () => {
      const cam = await fakeTcpCamera(framing);
      const port = cam.port;
      await cam.stop();
      closers.pop();
      const d = makeTcp({ ...cam, port });
      d.start();
      await wait(500);
      expect(d.getState().online).toBe(false);
      await expect(d.send({ type: 'power', on: true })).rejects.toThrow();
    });
  });

  it('uses raw framing and port 5678 for TCP unless told otherwise', async () => {
    const d = new ViscaDriver(device('dsp', { kind: 'driver', driverId: 'visca-ip' }, { host: '127.0.0.1', transport: 'tcp' }), ctx);
    expect((d as unknown as { framing: string; port: number }).framing).toBe('raw');
    expect((d as unknown as { framing: string; port: number }).port).toBe(5678);
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
