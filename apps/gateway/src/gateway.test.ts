import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair } from '@kestrel/crypto';
import type { MonitoredDevice } from '@kestrel/model';
import { CloudClient } from './cloud';
import type { GatewayConfig } from './config';
import { Gateway } from './gateway';
import { silentLogger } from './log';
import { Store } from './store';
import { CREDENTIAL, ENROLL_TOKEN, FakeCloud, GATEWAY_ID } from './test-support/fake-cloud';

let dir: string;
let cloud: FakeCloud;
const running: { gateway: Gateway; store: Store }[] = [];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await wait(15);
  }
}

function boot(over: Partial<GatewayConfig> = {}, url = cloud.url) {
  const cfg: GatewayConfig = {
    cloudUrl: url,
    enrollToken: ENROLL_TOKEN,
    dataDir: dir,
    panelPort: 0,
    panelHost: '127.0.0.1',
    logLevel: 'error',
    version: '0.0.0-test',
    ...over,
  };
  const store = new Store(join(dir, 'gateway.db'));
  const gateway = new Gateway(cfg, store, new CloudClient(url), silentLogger);
  running.push({ gateway, store });
  return { gateway, store, cfg };
}

/** Stops a booted gateway the way a restart would, so the next boot starts from what it saved. */
function shutDown(g: { gateway: Gateway; store: Store }) {
  g.gateway.stop();
  g.gateway.devices.shutdown();
  g.store.close();
  running.length = 0;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kestrel-gw-'));
  cloud = await new FakeCloud().start();
});
afterEach(async () => {
  for (const r of running.splice(0)) {
    r.gateway.stop();
    r.gateway.devices.shutdown();
    try {
      r.store.close();
    } catch {
      // already closed by the test
    }
  }
  await cloud.stop();
  rmSync(dir, { recursive: true, force: true });
});

const DEV = '00000000-0000-4000-8000-000000000001';
const device = (over: Partial<MonitoredDevice> = {}): MonitoredDevice => ({
  id: DEV,
  name: 'Lobby display',
  category: 'display',
  control: { kind: 'generic', protocol: 'pjlink' },
  // Nothing listens on this port, so the device reports offline: enough to prove it is polled.
  settings: { host: '127.0.0.1', port: 9 },
  ...over,
});
const set = (version: string, tamper = false, devices = [device()]) => ({
  version,
  tamper,
  devices,
});

describe('enrolment', () => {
  it('enrols once with the token and keeps the credential and identity', async () => {
    const { gateway, store } = boot();
    gateway.start();
    await until(() => cloud.heartbeats.length > 0);

    expect(cloud.enrols).toHaveLength(1);
    expect(cloud.enrols[0]).toMatchObject({ token: ENROLL_TOKEN, gatewayVersion: '0.0.0-test' });
    expect(store.get('credential')).toBe(CREDENTIAL);
    expect(gateway.identity).toMatchObject({ gatewayId: GATEWAY_ID, name: 'Test gateway' });
  });

  it('refuses to enrol with a bad token, and stores nothing', async () => {
    const { gateway, store } = boot({ enrollToken: 'wrong-token-000000' });
    await gateway.tick();
    expect(store.get('credential')).toBeNull();
    expect(cloud.enrols).toHaveLength(0);
  });

  it('without a token or credential it cannot enrol, but does not crash', async () => {
    const { gateway, store } = boot({ enrollToken: undefined });
    await gateway.tick();
    expect(store.get('credential')).toBeNull();
  });

  it('forgets a credential the cloud no longer recognises and re-enrols on its own', async () => {
    const { gateway, store } = boot();
    gateway.start();
    await until(() => cloud.heartbeats.length > 0);
    expect(store.get('credential')).toBe(CREDENTIAL);

    // The gateway's record was deleted and recreated in the portal: the old credential is dead,
    // but KESTREL_ENROLL_TOKEN is still configured from the reinstall.
    cloud.revoke();
    await gateway.tick();
    expect(store.get('credential')).toBeNull();
    expect(gateway.identity).toBeNull();

    await gateway.tick();
    expect(store.get('credential')).toBe(CREDENTIAL);
    expect(cloud.enrols.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the signing keys the cloud hands over when it enrols', async () => {
    const { gateway, store } = boot();
    gateway.start();
    await until(() => cloud.heartbeats.length > 0);
    expect(store.getJson<{ keyId: string }[]>('publicKeys')!.map((k) => k.keyId)).toEqual([
      'test-key',
    ]);
  });
});

describe('the heartbeat', () => {
  it('says what this gateway can do, and reports no rooms', async () => {
    const { gateway } = boot();
    gateway.start();
    await until(() => cloud.heartbeats.length > 0);
    const beat = cloud.heartbeats[0]!;
    expect(beat.rooms).toEqual([]);
    expect(beat.features).toEqual(
      expect.arrayContaining(['device-set', 'config-enforce', 'self-update', 'discovery']),
    );
    // Nothing that only a room-running gateway could do is claimed.
    expect(beat.features).not.toContain('bindings');
    expect(beat.features).not.toContain('schedule');
  });

  it('carries on when the cloud still hands out room work it no longer asks for', async () => {
    cloud.watching = ['33333333-3333-4333-8333-333333333331'];
    const { gateway } = boot();
    gateway.start();
    await until(() => cloud.heartbeats.length > 1, 8000);
    expect(gateway.status().problem).toBeNull();
  }, 15_000);
});

describe('offline operation', () => {
  it('buffers telemetry while the cloud is down and replays it, in order, with original times', async () => {
    const { gateway, store } = boot();
    gateway.start();
    await until(() => cloud.telemetry.some((e) => e.type === 'gateway.started'));

    cloud.up = false;
    gateway.record({ type: 'gateway.started', data: { n: 1 } });
    gateway.record({ type: 'gateway.started', data: { n: 2 } });
    await until(() => store.unsentCount() >= 2);
    await gateway.tick(); // fails: cloud is down
    expect(store.unsentCount()).toBeGreaterThanOrEqual(2);

    cloud.up = true;
    cloud.telemetry.length = 0;
    await gateway.tick();
    expect(store.unsentCount()).toBe(0);
    expect(cloud.telemetry.map((e) => e.data.n).filter(Boolean)).toEqual([1, 2]);
    const times = cloud.telemetry.map((e) => e.at);
    expect([...times].sort()).toEqual(times);
  });
});

describe('devices polled on their own', () => {
  const reported = () =>
    cloud.heartbeats.some((h) =>
      h.devices.some((d) => d.deviceId === DEV && d.name === 'Lobby display'),
    );

  it('fetches a verified device set, polls it and reports each device in the heartbeat', async () => {
    cloud.deviceSet = set('v1');
    const { gateway } = boot();
    gateway.start();
    await until(() => reported(), 12_000);
    expect(cloud.deviceSetFetches).toBe(1);
    expect(gateway.devices.setVersion).toBe('v1');
    expect(cloud.heartbeats.at(-1)!.deviceSetVersion).toBe('v1');
    expect(gateway.status().devices).toBe(1);
  }, 20_000);

  it('ignores a device set whose contents were changed after signing', async () => {
    cloud.deviceSet = set('v1', true);
    const { gateway } = boot();
    gateway.start();
    await until(() => cloud.deviceSetFetches > 0);
    await wait(100);
    expect(gateway.devices.size).toBe(0);
    expect(gateway.devices.setVersion).toBeNull();
  });

  it('does not take the cloud’s word for a key: a set signed with one it merely sent is refused', async () => {
    cloud.deviceSet = set('v1');
    // Built to trust some other key; the cloud offers (and signs with) its own.
    const { gateway } = boot({
      trustedKeys: [{ keyId: cloud.keyId, publicKeyPem: generateKeyPair().publicKeyPem }],
    });
    gateway.start();
    await until(() => cloud.deviceSetFetches > 0);
    await wait(100);
    expect(gateway.devices.size).toBe(0);
  });

  it('runs a set signed with a key built into it', async () => {
    cloud.deviceSet = set('v1');
    const { gateway } = boot({
      trustedKeys: [{ keyId: cloud.keyId, publicKeyPem: cloud.keys.publicKeyPem }],
    });
    gateway.start();
    await until(() => gateway.devices.setVersion === 'v1');
  });

  it('accepts the cloud’s keys as well when told to, and honours a key pinned by the operator', async () => {
    cloud.deviceSet = set('v1');
    const other = { keyId: 'someone-else', publicKeyPem: generateKeyPair().publicKeyPem };
    const a = boot({ trustedKeys: [other], trustCloudKeys: true });
    a.gateway.start();
    await until(() => a.gateway.devices.setVersion === 'v1');
    shutDown(a);

    const b = boot({ trustedKeys: [other], pinnedPublicKey: cloud.keys.publicKeyPem });
    b.gateway.start();
    await until(() => b.gateway.devices.setVersion === 'v1');
  });

  it('starts the saved devices again with no cloud, after a restart', async () => {
    cloud.deviceSet = set('v1');
    const first = boot();
    first.gateway.start();
    await until(() => first.gateway.devices.setVersion === 'v1');
    shutDown(first);

    cloud.up = false;
    const second = boot();
    second.gateway.start();
    await until(() => second.gateway.devices.setVersion === 'v1');
  });

  it('never starts a saved set from a key it does not trust after a restart', async () => {
    cloud.deviceSet = set('v1');
    const first = boot();
    first.gateway.start();
    await until(() => first.gateway.devices.setVersion === 'v1');
    shutDown(first);

    const second = boot(
      { trustedKeys: [{ keyId: cloud.keyId, publicKeyPem: generateKeyPair().publicKeyPem }] },
      'http://127.0.0.1:9',
    );
    second.gateway.start();
    await wait(150);
    expect(second.gateway.devices.size).toBe(0);
  });

  it('stops polling a device the cloud takes out of the set', async () => {
    cloud.deviceSet = set('v1');
    const { gateway } = boot();
    gateway.start();
    await until(() => gateway.devices.size === 1);
    cloud.deviceSet = set('v2', false, []);
    await until(() => gateway.devices.setVersion === 'v2', 12_000);
    expect(gateway.devices.size).toBe(0);
  }, 20_000);

  it('puts a setting back when the cloud sends one', async () => {
    cloud.deviceSet = set('v1');
    const { gateway } = boot();
    gateway.start();
    await until(() => gateway.devices.setVersion === 'v1');
    const sent: unknown[] = [];
    // Stand in for the device driver so the test does not need a real projector.
    (
      gateway.devices as unknown as { execute: (id: string, c: unknown) => Promise<boolean> }
    ).execute = async (id, c) => {
      sent.push({ id, c });
      return true;
    };
    cloud.queuedEnforce.push({ deviceId: DEV, command: { type: 'power', on: true } });
    await until(() => sent.length > 0, 12_000);
    expect(sent[0]).toEqual({ id: DEV, c: { type: 'power', on: true } });
  }, 20_000);
});

describe('remote commands', () => {
  it('refuses a command that is not on the allowlist, and reports it straight away', async () => {
    const { gateway } = boot();
    gateway.start();
    await until(() => cloud.heartbeats.length > 0);
    cloud.queuedCommands.push({
      id: '55555555-5555-4555-8555-555555555551',
      type: 'restart_room',
      roomId: '33333333-3333-4333-8333-333333333331',
      args: {},
    } as never);
    await gateway.tick();
    await until(() =>
      cloud.heartbeats.some((h) =>
        h.commandResults.some(
          (r) => r.id === '55555555-5555-4555-8555-555555555551' && r.ok === false,
        ),
      ),
    );
  });
});
