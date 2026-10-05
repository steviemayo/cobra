import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultDeviceState,
  type ControlPoint,
  type DeviceState,
  type SignedDeviceSet,
} from '@kestrel/model';
import { silentLogger } from './log';

const built: FakeDriver[] = [];

class FakeDriver {
  sent: unknown[] = [];
  failSend = false;
  starts = 0;
  closes = 0;
  state: DeviceState = defaultDeviceState();
  constructor(readonly id: string) {}
  private listeners = new Set<(s: DeviceState) => void>();
  getState() {
    return structuredClone(this.state);
  }
  onChange(l: (s: DeviceState) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit() {
    for (const l of this.listeners) l(this.getState());
  }
  browsed: unknown = { points: [{ path: 'Device.A', label: 'A', group: 'G' }], truncated: false };
  async browsePoints() {
    return this.browsed;
  }
  /** A camera's picture. Undefined means a driver with no snapshot. */
  snapshot?: () => Promise<{ contentType: 'image/jpeg'; bytes: Buffer }> = undefined;
  async send(c: unknown) {
    if (this.failSend) throw new Error('refused');
    this.sent.push(c);
  }
  start() {
    this.starts++;
  }
  close() {
    this.closes++;
  }
}

vi.mock('@kestrel/drivers/real', () => ({
  createDriver: (device: { id: string; control?: { kind: string } }) => {
    if (
      device.control?.kind === 'generic' &&
      device.id.startsWith('00000000-0000-4000-8000-00000000000n')
    )
      return null;
    const d = new FakeDriver(device.id);
    built.push(d);
    return d;
  },
}));

const { DeviceHost, SETTLE_MS } = await import('./device-host');
const { Prober } = await import('./probe');

// Long enough after a device opened that it counts as settled.
const LATER = () => Date.now() + SETTLE_MS + 1_000;

const ORG = '11111111-1111-4111-8111-111111111111';
const GW = '99999999-9999-4999-8999-999999999991';
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';

function set(
  version: string,
  devices: { id: string; host?: string; name?: string; points?: ControlPoint[] }[],
): SignedDeviceSet {
  return {
    payload: {
      orgId: ORG,
      gatewayId: GW,
      version,
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name ?? 'Display',
        category: 'display',
        control: { kind: 'generic' as const, protocol: 'pjlink' as const },
        settings: { host: d.host ?? '10.0.0.1' },
        ...(d.points && { points: d.points }),
      })),
    },
    hash: 'a'.repeat(64),
    signature: 'sig',
    keyId: 'k',
  };
}

beforeEach(() => {
  built.length = 0;
});

describe('DeviceHost control points', () => {
  const points: ControlPoint[] = [
    {
      id: 'g',
      name: 'Boardroom gain',
      type: 'level',
      address: { component: 'Boardroom', control: 'gain' },
      watch: { min: 20, severity: 'critical' },
    },
    {
      id: 'm',
      name: 'Boardroom mute',
      type: 'mute',
      address: { component: 'Boardroom', control: 'mute' },
      watch: { expect: false, severity: 'warning' },
    },
    {
      id: 's',
      name: 'Scene',
      type: 'generic',
      valueType: 'integer',
      address: { control: 'Scene' },
    },
    {
      id: 'late',
      name: 'Not read yet',
      type: 'generic',
      address: { control: 'Late' },
      watch: { expect: 1, severity: 'warning' },
    },
  ];

  it('hands the points to the driver and reports their readings and whether each is in bounds', () => {
    const host = new DeviceHost(silentLogger);
    host.apply(set('v1', [{ id: A, points }]));
    built[0]!.state.points = { g: 10, m: false, s: 2 };
    const report = host.reports(LATER())[0]!;
    // Only what has been read: the point with no reading yet is left out of both.
    expect(report.points).toEqual({ g: 10, m: false, s: 2 });
    expect(report.watched).toEqual([
      {
        pointId: 'g',
        name: 'Boardroom gain',
        ok: false,
        message: 'Boardroom gain is 10, below 20',
        severity: 'critical',
      },
      { pointId: 'm', name: 'Boardroom mute', ok: true, severity: 'warning' },
    ]);
  });

  it('reports nothing about points for a device that has none', () => {
    const host = new DeviceHost(silentLogger);
    host.apply(set('v1', [{ id: A }]));
    const report = host.reports(LATER())[0]!;
    expect(report.points).toBeUndefined();
    expect(report.watched).toBeUndefined();
  });

  it('rebuilds the driver when its points change, and not otherwise', () => {
    const host = new DeviceHost(silentLogger);
    host.apply(set('v1', [{ id: A, points }]));
    host.apply(set('v2', [{ id: A, points }]));
    expect(built).toHaveLength(1);
    host.apply(set('v3', [{ id: A, points: points.slice(0, 2) }]));
    expect(built).toHaveLength(2);
    expect(built[0]!.closes).toBe(1);
  });
});

describe('DeviceHost response times', () => {
  it('pings a device at its own address and puts the answers in its report', async () => {
    const asked: string[] = [];
    const prober = new Prober(async (host) => {
      asked.push(host);
      return 12;
    });
    const host = new DeviceHost(silentLogger, prober);
    host.apply(set('v1', [{ id: A, host: '10.0.0.7' }]));
    await prober.round();
    await prober.round();
    expect(asked).toEqual(['10.0.0.7', '10.0.0.7']);
    const report = host.reports(LATER())[0]!;
    expect(report.latency).toEqual({ sent: 2, ok: 2, minMs: 12, avgMs: 12, maxMs: 12 });
    // The window starts over with each report.
    expect(host.reports(LATER())[0]!.latency).toBeUndefined();
  });

  it('stops pinging a device that is removed', async () => {
    const asked: string[] = [];
    const prober = new Prober(async (h) => {
      asked.push(h);
      return 1;
    });
    const host = new DeviceHost(silentLogger, prober);
    host.apply(set('v1', [{ id: A }]));
    host.apply(set('v2', []));
    await prober.round();
    expect(asked).toEqual([]);
  });
});

describe('DeviceHost', () => {
  it('starts one driver per device and remembers the version', () => {
    const host = new DeviceHost(silentLogger);
    host.apply(set('v1', [{ id: A }, { id: B }]));
    expect(built).toHaveLength(2);
    expect(built.every((d) => d.starts === 1)).toBe(true);
    expect(host.size).toBe(2);
    expect(host.setVersion).toBe('v1');
  });

  it('leaves unchanged devices alone, rebuilds a changed address, and closes removed ones', () => {
    const host = new DeviceHost(silentLogger);
    host.apply(set('v1', [{ id: A }, { id: B }]));
    host.apply(set('v2', [{ id: A }, { id: B, host: '10.0.0.9' }]));
    const [a, b, b2] = built;
    expect(a!.closes).toBe(0);
    expect(b!.closes).toBe(1);
    expect(b2!.starts).toBe(1);
    host.apply(set('v3', [{ id: A }]));
    expect(host.size).toBe(1);
    expect(built[2]!.closes).toBe(1);
  });

  it('reports each device with its state, firmware and feedback', () => {
    const host = new DeviceHost(silentLogger);
    host.apply(set('v1', [{ id: A, name: 'Lobby display' }]));
    built[0]!.state = { ...defaultDeviceState(), online: false };
    expect(host.reports(LATER())).toEqual([
      { deviceId: A, name: 'Lobby display', online: false, driver: 'pjlink' },
    ]);
    built[0]!.state = { ...defaultDeviceState(), online: true, power: 'on', firmware: '2.1' };
    expect(host.reports(LATER())[0]).toMatchObject({
      online: true,
      firmware: '2.1',
      feedback: { power: 'on' },
    });
  });

  it('sends details when they change, not on every heartbeat', () => {
    const host = new DeviceHost(silentLogger);
    host.apply(set('v1', [{ id: A }]));
    const details = [{ title: 'Device', rows: [{ label: 'Serial number', value: 'SN1' }] }];
    built[0]!.state = { ...defaultDeviceState(), details };
    const t = LATER();
    expect(host.reports(t)[0]!.details).toBeDefined();
    expect(host.reports(t + 1_000)[0]!.details).toBeUndefined();
    built[0]!.state = {
      ...defaultDeviceState(),
      details: [{ title: 'Device', rows: [{ label: 'Serial number', value: 'SN2' }] }],
    };
    expect(host.reports(t + 2_000)[0]!.details).toBeDefined();
    // And once in a while regardless.
    expect(host.reports(t + 2_000 + 6 * 60_000)[0]!.details).toBeDefined();
  });

  it('does not report a device until it has answered or had a moment to', () => {
    const host = new DeviceHost(silentLogger);
    host.apply(set('v1', [{ id: A }, { id: B }]));
    expect(host.reports(Date.now())).toEqual([]);
    built[0]!.emit();
    expect(host.reports(Date.now()).map((r) => r.deviceId)).toEqual([A]);
    expect(host.reports(LATER()).map((r) => r.deviceId)).toEqual([A, B]);
  });

  it('sends a setting to a polled device, and says so when it cannot', async () => {
    const host = new DeviceHost(silentLogger);
    host.apply(set('v1', [{ id: A }]));
    expect(await host.execute(A, { type: 'power', on: true })).toBe(true);
    expect(built[0]!.sent).toEqual([{ type: 'power', on: true }]);
    built[0]!.failSend = true;
    expect(await host.execute(A, { type: 'power', on: false })).toBe(false);
    expect(await host.execute(B, { type: 'power', on: true })).toBe(false);
  });

  it('closes everything on shutdown', () => {
    const host = new DeviceHost(silentLogger);
    host.apply(set('v1', [{ id: A }, { id: B }]));
    host.shutdown();
    expect(built.every((d) => d.closes === 1)).toBe(true);
    expect(host.size).toBe(0);
  });
});

describe('DeviceHost tracked addresses', () => {
  const MAC = 'aa:bb:cc:dd:ee:01';
  const tracked = (host: string, extra: Record<string, unknown> = {}): SignedDeviceSet => {
    const base = set('v1', [{ id: A, host }]);
    base.payload.devices[0]!.settings = {
      host,
      port: 4352,
      addressTracking: { mac: MAC, name: 'Display', ...extra },
    };
    return base;
  };
  const addressDeps = (now: { t: number }) => ({
    lookupHost: async () => undefined,
    arp: async () => new Map([['10.0.0.9', MAC]]),
    open: async (h: string) => h === '10.0.0.9',
    pjlink: async () => ({}),
    subnets: () => [{ prefix: '10.0.0', own: new Set(['10.0.0.2']) }],
    now: () => now.t,
  });

  it('keeps the tracking details away from the driver and does not rebuild when they change', () => {
    const host = new DeviceHost(silentLogger);
    host.apply(tracked('10.0.0.1'));
    expect(built).toHaveLength(1);
    host.apply(tracked('10.0.0.1', { refindAt: '2026-10-03T09:00:00Z' }));
    expect(built).toHaveLength(1);
  });

  it('runs a moved device at its new address and reports the move until the cloud agrees', async () => {
    const now = { t: 5_000_000 };
    const host = new DeviceHost(silentLogger, undefined, undefined, addressDeps(now));
    const urgent = vi.fn();
    host.onUrgent = urgent;
    host.apply(tracked('10.0.0.1'));
    built[0]!.state.online = false;
    await host.tickAddresses();
    now.t += 15_000;
    await host.tickAddresses();
    // A new driver is running at the new address, the old one is closed, and the cloud is told at once.
    expect(built).toHaveLength(2);
    expect(built[0]!.closes).toBe(1);
    expect(urgent).toHaveBeenCalled();
    const report = host.reports(LATER()).find((r) => r.deviceId === A)!;
    expect(report.address?.change).toEqual({ from: '10.0.0.1', to: '10.0.0.9', how: 'mac' });
    // The next set still has the old address: nothing is rebuilt and the move is still reported.
    host.apply(tracked('10.0.0.1'));
    expect(built).toHaveLength(2);
    expect(host.reports(LATER()).find((r) => r.deviceId === A)!.address?.change?.to).toBe(
      '10.0.0.9',
    );
    // Once the cloud's set carries the new address the report stops.
    host.apply(tracked('10.0.0.9'));
    expect(built).toHaveLength(2);
    expect(host.reports(LATER()).find((r) => r.deviceId === A)!.address?.change).toBeUndefined();
    host.shutdown();
  });

  it('never moves a device that is not tracked', async () => {
    const now = { t: 5_000_000 };
    const host = new DeviceHost(silentLogger, undefined, undefined, addressDeps(now));
    host.apply(set('v1', [{ id: A, host: '10.0.0.1' }]));
    built[0]!.state.online = false;
    await host.tickAddresses();
    now.t += 15_000;
    await host.tickAddresses();
    expect(built).toHaveLength(1);
    expect(host.reports(LATER())[0]!.address).toBeUndefined();
  });
});

describe('DeviceHost browse', () => {
  it('lists a running device and says why when it cannot', async () => {
    const host = new DeviceHost(silentLogger);
    host.apply(set('v1', [{ id: A }]));
    expect(await host.browse(A)).toEqual({
      ok: true,
      found: { points: [{ path: 'Device.A', label: 'A', group: 'G' }], truncated: false },
    });
    expect(await host.browse(B)).toEqual({
      ok: false,
      error: 'This gateway is not polling that device yet',
    });
    built[0]!.browsePoints = async () => {
      throw new Error('The device is offline, so it cannot be browsed right now');
    };
    expect(await host.browse(A)).toEqual({
      ok: false,
      error: 'The device is offline, so it cannot be browsed right now',
    });
    host.shutdown();
  });
});

describe('DeviceHost snapshot', () => {
  it('hands back one picture as base64, and says why when it cannot', async () => {
    const host = new DeviceHost(silentLogger);
    host.apply(set('v1', [{ id: A }]));
    expect(await host.snapshot(A)).toEqual({ ok: false, error: 'This device cannot give a picture' });
    expect(await host.snapshot(B)).toEqual({
      ok: false,
      error: 'This gateway is not polling that device yet',
    });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    built[0]!.snapshot = async () => ({ contentType: 'image/jpeg', bytes: jpeg });
    expect(await host.snapshot(A)).toEqual({
      ok: true,
      contentType: 'image/jpeg',
      data: jpeg.toString('base64'),
    });
    built[0]!.snapshot = async () => {
      throw new Error('the camera rejected the login');
    };
    expect(await host.snapshot(A)).toEqual({ ok: false, error: 'the camera rejected the login' });
    host.shutdown();
  });

  it('refuses a picture too large to send in a heartbeat', async () => {
    const host = new DeviceHost(silentLogger);
    host.apply(set('v1', [{ id: A }]));
    built[0]!.snapshot = async () => ({ contentType: 'image/jpeg', bytes: Buffer.alloc(1_600_000) });
    const res = await host.snapshot(A);
    expect(res).toMatchObject({ ok: false });
    expect(res.ok === false && res.error).toContain('too large');
    host.shutdown();
  });
});
