import { createSocket, type Socket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { DriverSpec, STARTER_TEMPLATES, type Device } from '@kestrel/model';
import { DeclarativeDriver } from './declarative';
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

async function fakeUdp(reply?: (msg: string) => string | null) {
  const received: string[] = [];
  const server: Socket = createSocket('udp4');
  server.on('message', (m, rinfo) => {
    const text = m.toString('utf8');
    received.push(text);
    const out = reply?.(text);
    if (out) server.send(out, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => server.bind(0, '127.0.0.1', r));
  closers.push(() => server.close());
  return { port: server.address().port, received };
}

const spec = (port: number, extra: Record<string, unknown> = {}) =>
  DriverSpec.parse({
    id: 'acme-udp',
    name: 'Acme UDP',
    transport: { type: 'udp', port, timeoutMs: 800 },
    commands: {
      'power.on': { send: 'PWR ON' },
      'power.off': { send: 'PWR OFF', expect: '^OK' },
      volume: { send: 'VOL {level}' },
    },
    volumeScale: { min: 0, max: 100 },
    ...extra,
  });

const make = (s: DriverSpec, port: number) => {
  const device: Device = {
    ...base.devices.find((d) => d.id === 'dsp')!,
    control: { kind: 'driver', driverId: 'custom:acme-udp' },
    settings: { host: '127.0.0.1', port },
  };
  const d = new DeclarativeDriver(device, ctx, s);
  drivers.push(d);
  return d;
};

describe('a UDP driver', () => {
  it('sends one datagram per command with the placeholders filled in', async () => {
    const fake = await fakeUdp();
    const d = make(spec(fake.port), fake.port);
    d.start();
    await d.send({ type: 'power', on: true });
    await d.send({ type: 'volume', level: 40 });
    await until(() => fake.received.length === 2);
    expect(fake.received).toEqual(['PWR ON', 'VOL 40']);
  });

  it('waits for the expected reply, and fails when the device says something else', async () => {
    const ok = await fakeUdp(() => 'OK');
    const good = make(spec(ok.port), ok.port);
    good.start();
    await expect(good.send({ type: 'power', on: false })).resolves.toBeUndefined();

    const bad = await fakeUdp(() => 'ERR');
    const wrong = make(spec(bad.port), bad.port);
    wrong.start();
    await expect(wrong.send({ type: 'power', on: false })).rejects.toThrow(/did not respond/);
  });

  it('reads feedback from a polled reply and goes online', async () => {
    const fake = await fakeUdp((m) => (m === 'STATUS?' ? 'POWER=ON' : null));
    const s = spec(fake.port, {
      feedback: {
        poll: [{ action: { send: 'STATUS?' }, everyMs: 1000 }],
        patterns: [{ match: '^POWER=(ON|OFF)', set: 'power', value: '$1' }],
      },
    });
    const d = make(s, fake.port);
    d.start();
    await until(() => d.getState().online === true);
    expect(d.getState().power).toBe('on');
  });

  it('stays unknown, not online, when there is nothing to poll', async () => {
    const fake = await fakeUdp();
    const d = make(spec(fake.port), fake.port);
    d.start();
    await wait(100);
    expect(d.getState().online).toBe(false);
  });
});
