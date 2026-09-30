import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDeviceState, type DeviceState, type SignedDeviceSet } from '@kestrel/model';
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

// Long enough after a device opened that it counts as settled.
const LATER = () => Date.now() + SETTLE_MS + 1_000;

const ORG = '11111111-1111-4111-8111-111111111111';
const GW = '99999999-9999-4999-8999-999999999991';
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';

function set(
  version: string,
  devices: { id: string; host?: string; name?: string }[],
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
