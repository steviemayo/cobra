import { describe, expect, it } from 'vitest';
import { defaultDeviceState, type Device, type DeviceCommand, type DeviceState } from '@kestrel/model';
import type { DeviceDriver } from '@kestrel/drivers/real';
import { silentLogger } from './log';
import { SharedDevices } from './shared-devices';

const SITE_DEVICE = '77777777-7777-4777-8777-777777777771';

class FakeDriver implements DeviceDriver {
  readonly deviceId = 'physical';
  readonly sent: DeviceCommand[] = [];
  starts = 0;
  closes = 0;
  state: DeviceState = defaultDeviceState();
  private listeners = new Set<(s: DeviceState) => void>();
  active = 0;
  maxActive = 0;
  failNext = false;

  constructor(readonly device: Device) {}

  async send(command: DeviceCommand) {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((r) => setTimeout(r, 5));
    this.active--;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('device refused');
    }
    this.sent.push(command);
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
    for (const l of this.listeners) l(this.getState());
  }
  start() {
    this.starts++;
  }
  close() {
    this.closes++;
  }
}

const device = (id: string, over: Partial<Device> = {}): Device => ({
  id,
  name: 'Matrix',
  category: 'video_matrix',
  ports: [],
  extraCapabilities: [],
  settings: {},
  ...over,
});
const port = (id: string, direction: 'in' | 'out', maps?: string) => ({ id, name: id, direction, signal: 'av' as const, ...(maps ? { maps } : {}) });

function world(exclusive = false) {
  const shared = new SharedDevices(silentLogger);
  const built: FakeDriver[] = [];
  const attach = (roomId: string, roomName: string, d: Device) =>
    shared.attach({
      siteDeviceId: SITE_DEVICE,
      exclusive,
      roomId,
      roomName,
      device: d,
      build: (dev) => {
        const driver = new FakeDriver(dev);
        built.push(driver);
        return driver;
      },
    })!;
  return { shared, built, attach };
}

describe('one connection for many rooms', () => {
  it('opens the device once, starts it once, and closes it when the last room lets go', () => {
    const w = world();
    const a = w.attach('A', 'Room A', device('m'));
    const b = w.attach('B', 'Room B', device('m'));
    expect(w.built).toHaveLength(1);
    expect(w.shared.size).toBe(1);
    a.start();
    b.start();
    expect(w.built[0]!.starts).toBe(1);
    a.close();
    expect(w.built[0]!.closes).toBe(0);
    b.close();
    expect(w.built[0]!.closes).toBe(1);
    expect(w.shared.size).toBe(0);
  });

  it('a room that stages its replacement and then lets go of the old one keeps the connection', () => {
    const w = world();
    const oldRoom = w.attach('A', 'Room A', device('m'));
    const staged = w.attach('A', 'Room A', device('m'));
    oldRoom.close();
    expect(w.built[0]!.closes).toBe(0);
    staged.close();
    expect(w.built[0]!.closes).toBe(1);
  });

  it('runs every room’s commands one at a time, in the order they arrived, even after a failure', async () => {
    const w = world();
    const a = w.attach('A', 'Room A', device('m'));
    const b = w.attach('B', 'Room B', device('m'));
    w.built[0]!.failNext = true;
    const results = await Promise.allSettled([
      a.send({ type: 'volume', level: 1 }),
      b.send({ type: 'volume', level: 2 }),
      a.send({ type: 'volume', level: 3 }),
      b.send({ type: 'volume', level: 4 }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(w.built[0]!.sent.map((c) => (c as { level: number }).level)).toEqual([2, 3, 4]);
    expect(w.built[0]!.maxActive).toBe(1);
  });

  it('tells every room what the device says', () => {
    const w = world();
    const a = w.attach('A', 'Room A', device('m'));
    const b = w.attach('B', 'Room B', device('m'));
    const heard: string[] = [];
    a.onChange((s) => heard.push(`A:${s.volume}`));
    b.onChange((s) => heard.push(`B:${s.volume}`));
    w.built[0]!.push({ volume: 40 });
    expect(heard).toEqual(['A:40', 'B:40']);
    expect(a.getState().volume).toBe(40);
  });

  it('stops telling a room once it has let go', () => {
    const w = world();
    const a = w.attach('A', 'Room A', device('m'));
    const b = w.attach('B', 'Room B', device('m'));
    const heard: string[] = [];
    a.onChange(() => heard.push('A'));
    b.onChange(() => heard.push('B'));
    a.close();
    w.built[0]!.push({ volume: 1 });
    expect(heard).toEqual(['B']);
  });
});

describe('each room uses its own ports', () => {
  const matrixFor = (outMap: string) =>
    device('m', { ports: [port('in1', 'in', 'hdmi1'), port('in2', 'in', 'hdmi2'), port('out1', 'out', outMap)] });

  it('translates a route to the physical ports, and only the mapped ones', async () => {
    const w = world();
    const a = w.attach('A', 'Room A', matrixFor('out3'));
    const b = w.attach('B', 'Room B', matrixFor('out4'));
    await a.send({ type: 'route', inputPortId: 'in2', outputPortId: 'out1' });
    await b.send({ type: 'select_input', portId: 'in1' });
    expect(w.built[0]!.sent).toEqual([
      { type: 'route', inputPortId: 'hdmi2', outputPortId: 'out3' },
      { type: 'select_input', portId: 'hdmi1' },
    ]);
  });

  it('shows a room only the routes and signals of its own ports, under its own names', () => {
    const w = world();
    const a = w.attach('A', 'Room A', matrixFor('out3'));
    const b = w.attach('B', 'Room B', matrixFor('out4'));
    w.built[0]!.push({ routes: { out3: 'hdmi2', out4: 'hdmi1', out9: 'hdmi1' }, signal: { hdmi1: true, hdmi2: false, hdmi7: true } });
    expect(a.getState()).toMatchObject({ routes: { out1: 'in2' }, signal: { in1: true, in2: false } });
    expect(b.getState()).toMatchObject({ routes: { out1: 'in1' } });
    expect(Object.keys(a.getState().signal)).toEqual(['in1', 'in2']);
  });

  it('a route from something the room does not have shows as nothing', () => {
    const w = world();
    const a = w.attach('A', 'Room A', matrixFor('out3'));
    w.built[0]!.push({ routes: { out3: 'hdmi9' } });
    expect(a.getState().routes).toEqual({ out1: null });
    w.built[0]!.push({ routes: { out3: null } });
    expect(a.getState().routes).toEqual({ out1: null });
  });

  it('a room with no mapping sees the whole device as it is', async () => {
    const w = world();
    const a = w.attach('A', 'Room A', device('m', { ports: [port('in1', 'in'), port('out1', 'out')] }));
    w.built[0]!.push({ routes: { out1: 'in1', out2: 'in1' } });
    expect(a.getState().routes).toEqual({ out1: 'in1', out2: 'in1' });
    await a.send({ type: 'route', inputPortId: 'in1', outputPortId: 'out1' });
    expect(w.built[0]!.sent[0]).toEqual({ type: 'route', inputPortId: 'in1', outputPortId: 'out1' });
  });
});

describe('control points of several rooms', () => {
  const vol = (address: string) => ({ id: 'vol', name: 'Volume', type: 'level' as const, address: { component: address, control: 'gain' } });

  it('keeps each room’s point under its own name, so two rooms can both have a point called vol', async () => {
    const w = world();
    const a = w.attach('A', 'Room A', device('dsp', { points: [vol('RoomA')] }));
    const b = w.attach('B', 'Room B', device('dsp', { points: [vol('RoomB')] }));
    const driverPoints = w.built[0]!.device.points!;
    expect(driverPoints).toHaveLength(2);
    expect(new Set(driverPoints.map((p) => p.id)).size).toBe(2);
    expect(driverPoints.map((p) => p.address.component).sort()).toEqual(['RoomA', 'RoomB']);

    await a.send({ type: 'point', pointId: 'vol', value: 10 });
    await b.send({ type: 'point', pointId: 'vol', value: 90 });
    const [first, second] = w.built[0]!.sent as { pointId: string; value: number }[];
    expect(first!.pointId).not.toBe(second!.pointId);

    w.built[0]!.push({ points: { [first!.pointId]: 10, [second!.pointId]: 90 } });
    expect(a.getState().points).toEqual({ vol: 10 });
    expect(b.getState().points).toEqual({ vol: 90 });
  });

  it('forgets a room’s points when it lets go', () => {
    const w = world();
    const a = w.attach('A', 'Room A', device('dsp', { points: [vol('RoomA')] }));
    w.attach('B', 'Room B', device('dsp', { points: [vol('RoomB')] }));
    a.close();
    expect(w.built[0]!.device.points!.map((p) => p.address.component)).toEqual(['RoomB']);
  });
});

describe('a device that serves one room at a time', () => {
  it('is refused to a second room while the first is on, and free again when it turns off', async () => {
    const w = world(true);
    const a = w.attach('A', 'Room A', device('codec'));
    const b = w.attach('B', 'Room B', device('codec'));
    w.shared.acquire('A', 'Room A');
    w.shared.acquire('B', 'Room B'); // taken already: does nothing
    expect(w.shared.holderOf(SITE_DEVICE)).toBe('Room A');
    await a.send({ type: 'power', on: true });
    await expect(b.send({ type: 'power', on: true })).rejects.toThrow('Matrix is in use by Room A');
    expect(w.built[0]!.sent).toHaveLength(1);
    w.shared.release('A');
    await b.send({ type: 'power', on: true });
    expect(w.built[0]!.sent).toHaveLength(2);
  });

  it('is not held by a room that does not use it, and a release by another room changes nothing', () => {
    const w = world(true);
    w.attach('A', 'Room A', device('codec'));
    w.shared.acquire('C', 'Room C');
    expect(w.shared.holderOf(SITE_DEVICE)).toBeNull();
    w.shared.acquire('A', 'Room A');
    w.shared.release('C');
    expect(w.shared.holderOf(SITE_DEVICE)).toBe('Room A');
  });

  it('a device that is not exclusive is never refused', async () => {
    const w = world(false);
    const a = w.attach('A', 'Room A', device('m'));
    const b = w.attach('B', 'Room B', device('m'));
    w.shared.acquire('A', 'Room A');
    await a.send({ type: 'power', on: true });
    await b.send({ type: 'power', on: true });
    expect(w.built[0]!.sent).toHaveLength(2);
  });
});
