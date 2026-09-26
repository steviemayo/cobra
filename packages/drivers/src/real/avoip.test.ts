import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RoomModel,
  STARTER_TEMPLATES,
  addAvoipSystem,
  defaultDeviceState,
  type Device,
  type DeviceCommand,
  type DeviceState,
} from '@kestrel/model';
import { AvoipSwitcher, avoipWiring, attachVirtualDrivers } from './avoip';
import { createDriver } from './registry';
import type { DeviceDriver, DriverContext } from './types';

const ctx: DriverContext = { log: () => undefined };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await wait(10);
  }
}

// ---- The system under test ----------------------------------------------------------------------

function system(encoders = 2, decoders = 2) {
  const model = RoomModel.parse({ roomType: 'meeting' });
  const made = addAvoipSystem(model, { family: 'crestron-nvx', encoders, decoders });
  if (!made.ok) throw new Error(made.message);
  return { model, ...made } as { model: RoomModel } & Required<typeof made>;
}

/** An endpoint the test can steer: what it says, and what it was asked. */
class FakeEndpoint implements DeviceDriver {
  sent: DeviceCommand[] = [];
  state: DeviceState = { ...defaultDeviceState(), online: true };
  private listeners = new Set<(s: DeviceState) => void>();
  autoConnect = true;
  connectDelayMs = 15;
  location = 'stream-1';
  constructor(readonly deviceId: string) {}
  async send(c: DeviceCommand) {
    this.sent.push(c);
    if (c.type === 'set_stream' && this.autoConnect)
      setTimeout(() => this.push({ streamConnected: c.location !== null, ...(c.location ? { streamLocation: c.location } : {}) }), this.connectDelayMs);
  }
  async streamLocation() {
    return this.location;
  }
  getState() {
    return structuredClone(this.state);
  }
  onChange(l: (s: DeviceState) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  push(patch: Partial<DeviceState>) {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l(this.getState());
  }
  start() {}
  close() {}
}

function build(encoders = 2, decoders = 2) {
  const s = system(encoders, decoders);
  const real = new Map<string, DeviceDriver>();
  const enc = s.encoderIds.map((id, i) => {
    const e = new FakeEndpoint(id);
    e.location = `stream-enc${i + 1}`;
    real.set(id, e);
    return e;
  });
  const dec = s.decoderIds.map((id) => {
    const d = new FakeEndpoint(id);
    real.set(id, d);
    return d;
  });
  attachVirtualDrivers(s.model, real, ctx);
  const switcher = real.get(s.switcherId) as AvoipSwitcher;
  switcher.start();
  return { ...s, real, enc, dec, switcher };
}

const drivers: DeviceDriver[] = [];
afterEach(() => drivers.splice(0).forEach((d) => d.close()));
const track = <T extends DeviceDriver>(d: T) => (drivers.push(d), d);

describe('adding an AVoIP system', () => {
  it('creates a switcher, the endpoints and the wiring source, encoder, switcher, decoder', () => {
    const { model, switcherId, encoderIds, decoderIds } = system(2, 3);
    expect(model.devices.filter((d) => d.category === 'avoip_encoder')).toHaveLength(2);
    expect(model.devices.filter((d) => d.category === 'avoip_decoder')).toHaveLength(3);
    const sw = model.devices.find((d) => d.id === switcherId)!;
    expect(sw.control).toEqual({ kind: 'driver', driverId: 'crestron-nvx-switcher' });
    expect(sw.ports.map((p) => p.id)).toEqual(['in1', 'in2', 'out1', 'out2', 'out3']);
    expect(model.connections).toHaveLength(5);
    expect(avoipWiring(model, switcherId)).toEqual({
      encoders: new Map([['in1', encoderIds[0]], ['in2', encoderIds[1]]]),
      decoders: new Map([['out1', decoderIds[0]], ['out2', decoderIds[1]], ['out3', decoderIds[2]]]),
    });
    expect(() => RoomModel.parse(model)).not.toThrow();
  });

  it('keeps ids unique when added twice, and refuses nonsense', () => {
    const { model } = system(1, 1);
    const again = addAvoipSystem(model, { family: 'crestron-nvx', encoders: 1, decoders: 1 });
    expect(again.ok).toBe(true);
    const ids = model.devices.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(addAvoipSystem(model, { family: 'nope', encoders: 1, decoders: 1 }).ok).toBe(false);
    expect(addAvoipSystem(model, { family: 'crestron-nvx', encoders: 0, decoders: 1 }).ok).toBe(false);
    expect(addAvoipSystem(model, { family: 'crestron-nvx', encoders: 60, decoders: 60 }).ok).toBe(false);
  });
});

describe('the virtual switcher', () => {
  it('reads the stream, points the decoder at it, and waits until the decoder is receiving', async () => {
    const t = build();
    t.dec[0]!.connectDelayMs = 60;
    const started = Date.now();
    await t.switcher.send({ type: 'route', inputPortId: 'in2', outputPortId: 'out1' });
    expect(t.dec[0]!.sent).toEqual([{ type: 'set_stream', location: 'stream-enc2' }]);
    // It did not report done until the decoder said so: no fixed wait, no early answer.
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(t.switcher.getState().routes).toEqual({ out1: 'in2', out2: null });
    expect(t.enc[1]!.sent).toEqual([]);
  });

  it('answers at once when the decoder is already receiving', async () => {
    const t = build();
    t.dec[0]!.autoConnect = false;
    t.dec[0]!.state.streamConnected = true;
    await t.switcher.send({ type: 'route', inputPortId: 'in1', outputPortId: 'out1' });
    expect(t.switcher.getState().routes.out1).toBe('in1');
  });

  it('fails, and does not record the route, when the decoder never receives the stream', async () => {
    const t = build();
    t.dec[1]!.autoConnect = false;
    const sw = createSwitcherWithTimeout(t, 80);
    await expect(sw.send({ type: 'route', inputPortId: 'in1', outputPortId: 'out2' })).rejects.toThrow(/is not receiving the stream/);
    expect(sw.getState().routes.out2).toBeNull();
  });

  it('fails clearly for a port with nothing wired to it, and for an endpoint with no driver', async () => {
    const t = build();
    await expect(t.switcher.send({ type: 'route', inputPortId: 'in9', outputPortId: 'out1' })).rejects.toThrow(/no encoder wired/);
    await expect(t.switcher.send({ type: 'route', inputPortId: 'in1', outputPortId: 'out9' })).rejects.toThrow(/no decoder wired/);
    t.real.delete(t.decoderIds[0]!);
    await expect(t.switcher.send({ type: 'route', inputPortId: 'in1', outputPortId: 'out1' })).rejects.toThrow(/has no driver/);
    t.real.set(t.encoderIds[0]!, { ...new FakeEndpoint('x'), streamLocation: undefined } as unknown as DeviceDriver);
  });

  it('follows the stream: when an encoder comes back with a new stream, the decoders showing it are pointed at it', async () => {
    const t = build();
    await t.switcher.send({ type: 'route', inputPortId: 'in1', outputPortId: 'out1' });
    await t.switcher.send({ type: 'route', inputPortId: 'in2', outputPortId: 'out2' });
    t.enc[0]!.location = 'stream-enc1-new';
    t.enc[0]!.push({ streamLocation: 'stream-enc1' }); // first sighting: nothing to compare
    t.enc[0]!.push({ streamLocation: 'stream-enc1-new' });
    await until(() => t.dec[0]!.sent.length === 2);
    expect(t.dec[0]!.sent.at(-1)).toEqual({ type: 'set_stream', location: 'stream-enc1-new' });
    expect(t.dec[1]!.sent).toHaveLength(1); // showing another encoder: untouched
  });

  it('re-applies a route when its decoder comes back from a reboot', async () => {
    const t = build();
    await t.switcher.send({ type: 'route', inputPortId: 'in2', outputPortId: 'out1' });
    t.dec[0]!.push({ online: false, streamConnected: false });
    expect(t.switcher.getState().online).toBe(false);
    t.dec[0]!.push({ online: true });
    await until(() => t.dec[0]!.sent.length === 2);
    expect(t.dec[0]!.sent.at(-1)).toEqual({ type: 'set_stream', location: 'stream-enc2' });
    await until(() => t.switcher.getState().online);
  });

  it('does not re-apply a route it was never asked for, and does not loop on a decoder that keeps failing', async () => {
    const t = build();
    t.dec[0]!.push({ online: false });
    t.dec[0]!.push({ online: true });
    await wait(50);
    expect(t.dec[0]!.sent).toEqual([]);
    await t.switcher.send({ type: 'route', inputPortId: 'in1', outputPortId: 'out1' });
    t.dec[0]!.autoConnect = false;
    for (let i = 0; i < 5; i++) t.dec[0]!.push({ streamConnected: false });
    await wait(50);
    expect(t.dec[0]!.sent.length).toBeLessThanOrEqual(3);
  });

  it('is online only when every endpoint is, and reports a signal per encoder input', async () => {
    const t = build();
    expect(t.switcher.getState().online).toBe(true);
    t.enc[1]!.push({ signal: { in: true } });
    expect(t.switcher.getState().signal).toEqual({ in1: false, in2: true });
    t.dec[1]!.push({ online: false });
    expect(t.switcher.getState().online).toBe(false);
    t.dec[1]!.push({ online: true });
    expect(t.switcher.getState().online).toBe(true);
  });

  it('stops listening to the endpoints when it is closed', () => {
    const t = build();
    t.switcher.close();
    t.dec[0]!.push({ online: false });
    expect(t.switcher.getState().online).toBe(true);
  });

  it('is what an NVX switcher device asks for, and the endpoints too', () => {
    const { model, switcherId, encoderIds } = build();
    const encoder = model.devices.find((d) => d.id === encoderIds[0])!;
    expect(createDriver({ ...encoder, settings: { host: '127.0.0.1' } }, ctx)?.features?.()).toEqual(['stream_location', 'signal_detect']);
    // The switcher has no address of its own, so the plain factory builds nothing: the room builds it.
    expect(createDriver(model.devices.find((d) => d.id === switcherId)!, ctx)).toBeNull();
  });
});

/** The same system with a shorter wait for a decoder, so a failure test is quick. */
function createSwitcherWithTimeout(t: ReturnType<typeof build>, ms: number) {
  const sw = new AvoipSwitcher({ ...t.model.devices.find((d) => d.id === t.switcherId)!, settings: { timeoutMs: ms } } as Device, t.model, t.real, ctx);
  sw.start();
  return track(sw);
}

// ---- The NVX endpoint drivers against a fake unit ----------------------------------------------

interface Unit {
  port: number;
  routes: string[];
  posts: string[];
  set: { uuid: string; sync: boolean; source: string };
}

const servers: http.Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function fakeUnit(): Promise<Unit> {
  const unit = { routes: [] as string[], posts: [] as string[], set: { uuid: 'uuid-1', sync: true, source: '' } } as Unit;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (o: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (req.url === '/Device/StreamTransmit') return json({ Device: { StreamTransmit: { Streams: [{ UUID: unit.set.uuid }] } } });
      if (req.url === '/Device/AudioVideoInputOutput')
        return json({ Device: { AudioVideoInputOutput: { Inputs: [{ Ports: [{ IsSyncDetected: unit.set.sync }] }] } } });
      if (req.url === '/Device/AvRouting') return json({ Device: { AvRouting: { Routes: [{ VideoSource: unit.set.source }] } } });
      if (req.method === 'POST' && req.url === '/Device') {
        unit.posts.push(body);
        const route = (JSON.parse(body) as { Device: { AvRouting?: { Routes: { VideoSource: string }[] } } }).Device.AvRouting;
        if (route) unit.set.source = route.Routes[0]!.VideoSource;
        return json({ Actions: [{ Results: [{ StatusId: 0 }] }] });
      }
      res.writeHead(404);
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  unit.port = (server.address() as { port: number }).port;
  return unit;
}

const endpointDevice = (category: 'avoip_encoder' | 'avoip_decoder', driverId: string, port: number): Device => {
  const base = STARTER_TEMPLATES[0]!.model.devices[0]!;
  return {
    ...base,
    id: 'ep',
    category,
    ports: category === 'avoip_encoder' ? [{ id: 'in', name: 'in', direction: 'in', signal: 'av' }, { id: 'net', name: 'net', direction: 'out', signal: 'av' }] : [],
    control: { kind: 'driver', driverId },
    settings: { host: '127.0.0.1', port, protocol: 'http', username: 'admin', password: 'x', pollMs: 60, timeoutMs: 800 },
  };
};

describe('NVX encoder and decoder drivers', () => {
  it('an encoder reports where its stream is and whether its input has a signal', async () => {
    const unit = await fakeUnit();
    const d = track(createDriver(endpointDevice('avoip_encoder', 'crestron-nvx-encoder', unit.port), ctx)!);
    d.start();
    await until(() => d.getState().online && d.getState().streamLocation === 'uuid-1' && d.getState().signal.in === true);
    expect(d.getState().signal).toEqual({ in: true });
    expect(await d.streamLocation!()).toBe('uuid-1');
    unit.set.uuid = 'uuid-2';
    expect(await d.streamLocation!()).toBe('uuid-2');
  });

  it('a decoder is pointed at a stream and reads back that it is receiving it', async () => {
    const unit = await fakeUnit();
    const d = track(createDriver(endpointDevice('avoip_decoder', 'crestron-nvx-decoder', unit.port), ctx)!);
    d.start();
    await until(() => d.getState().online);
    expect(d.getState().streamConnected).toBe(false);
    await d.send({ type: 'set_stream', location: 'uuid-1' });
    expect(JSON.parse(unit.posts[0]!)).toEqual({ Device: { AvRouting: { Routes: [{ VideoSource: 'uuid-1', AudioSource: 'uuid-1' }] } } });
    expect(d.getState()).toMatchObject({ streamConnected: true, streamLocation: 'uuid-1' });
    await wait(150); // the next poll agrees
    expect(d.getState().streamConnected).toBe(true);
    // Something else changes its route behind our back: it is no longer receiving what we asked for.
    unit.set.source = 'someone-else';
    await until(() => d.getState().streamConnected === false);
    await d.send({ type: 'set_stream', location: null });
    expect(d.getState().streamConnected).toBe(false);
  });

  it('refuses commands it cannot do, and says when the unit is gone', async () => {
    const unit = await fakeUnit();
    const d = track(createDriver(endpointDevice('avoip_decoder', 'crestron-nvx-decoder', unit.port), ctx)!);
    await expect(d.send({ type: 'volume', level: 1 })).rejects.toThrow(/does not support/);
    servers.pop()!.close();
    await expect(d.send({ type: 'set_stream', location: 'x' })).rejects.toThrow();
    expect(d.getState().online).toBe(false);
  });
});
