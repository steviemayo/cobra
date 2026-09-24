import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, type RoomModel } from '@kestrel/model';
import { CloudClient } from './cloud';
import type { GatewayConfig } from './config';
import { Gateway } from './gateway';
import { silentLogger } from './log';
import { RoomHost } from './room-host';
import { Store } from './store';
import { CREDENTIAL, ENROLL_TOKEN, FakeCloud, GATEWAY_ID } from './test-support/fake-cloud';

const ROOM = '33333333-3333-4333-8333-333333333331';
const ROOM2 = '33333333-3333-4333-8333-333333333332';
const model = (): RoomModel => structuredClone(STARTER_TEMPLATES[0]!.model);

let dir: string;
let cloud: FakeCloud;
const running: { gateway: Gateway; host: RoomHost; store: Store }[] = [];

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
    panelDir: '',
    simulate: 'all',
    logLevel: 'error',
    version: '0.0.0-test',
    ...over,
  };
  const store = new Store(join(dir, 'gateway.db'));
  const host = new RoomHost('all', silentLogger, (e) => store.enqueue(e));
  const gateway = new Gateway(cfg, store, new CloudClient(url), host, silentLogger);
  running.push({ gateway, host, store });
  return { gateway, host, store, cfg };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kestrel-gw-'));
  cloud = await new FakeCloud().start();
});
afterEach(async () => {
  for (const r of running.splice(0)) {
    r.gateway.stop();
    r.host.shutdown();
    try {
      r.store.close();
    } catch {
      // already closed by the test
    }
  }
  await cloud.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('enrolment and sync', () => {
  it('enrols once with the token, stores the credential, and loads assigned rooms', async () => {
    cloud.assign(ROOM, model(), { name: 'Boardroom' });
    const { gateway, host, store } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));

    expect(cloud.enrols).toHaveLength(1);
    expect(cloud.enrols[0]).toMatchObject({ token: ENROLL_TOKEN, gatewayVersion: '0.0.0-test' });
    expect(store.get('credential')).toBe(CREDENTIAL);
    expect(gateway.identity).toMatchObject({ gatewayId: GATEWAY_ID, name: 'Test gateway' });
    expect(host.get(ROOM)!.runtime.getSnapshot().roomName).toBe('Boardroom');
  });

  it('caches the verified release locally', async () => {
    cloud.assign(ROOM, model());
    const { gateway, host, store } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));
    expect(store.loadManifests().map((m) => m.roomId)).toEqual([ROOM]);
  });

  it('reports what is running in the next heartbeat', async () => {
    const signed = cloud.assign(ROOM, model());
    const { gateway, host } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));
    await gateway.tick();
    const last = cloud.heartbeats.at(-1)!;
    expect(last.rooms).toEqual([{ roomId: ROOM, releaseId: signed.manifest.releaseId, status: 'off' }]);
    expect(last.configVersion).not.toBeNull();
    expect(last.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('does not fetch a release it is already running', async () => {
    cloud.assign(ROOM, model());
    const { gateway, host } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));
    const fetched = cloud.manifestFetches.length;
    await gateway.tick();
    await gateway.tick();
    expect(cloud.manifestFetches).toHaveLength(fetched);
  });

  it('replaces a room when a new release is assigned, and drops one that is unassigned', async () => {
    cloud.assign(ROOM, model(), { name: 'v1' });
    cloud.assign(ROOM2, model(), { name: 'other' });
    const { gateway, host, store } = boot();
    gateway.start();
    await until(() => host.ids().length === 2);
    const before = host.get(ROOM)!.runtime;

    cloud.assign(ROOM, model(), { name: 'v2' });
    await gateway.tick();
    expect(host.get(ROOM)!.runtime.getSnapshot().roomName).toBe('v2');
    expect(host.get(ROOM)!.runtime).not.toBe(before);
    expect(host.get(ROOM)!.signed.manifest.releaseNumber).toBe(2);

    cloud.unassign(ROOM2);
    await gateway.tick();
    expect(host.ids()).toEqual([ROOM]);
    expect(store.loadManifests().map((m) => m.roomId)).toEqual([ROOM]);
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

  it('picks up rotated public keys from the config', async () => {
    cloud.assign(ROOM, model());
    const { gateway, host, store } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));
    const next = { keyId: 'k2', publicKeyPem: cloud.keys.publicKeyPem };
    cloud.rotateKeys([...cloud.publicKeys, next]);
    await gateway.tick();
    expect(store.getJson<{ keyId: string }[]>('publicKeys')!.map((k) => k.keyId)).toEqual(['test-key', 'k2']);
  });
});

describe('verification', () => {
  it('refuses a manifest that was changed after signing, and keeps what is already running', async () => {
    cloud.assign(ROOM, model(), { name: 'Good v1' });
    const { gateway, host } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));

    cloud.assign(ROOM, model(), { name: 'Good v2', tamper: true });
    await gateway.tick();
    expect(host.get(ROOM)!.runtime.getSnapshot().roomName).toBe('Good v1');
    await gateway.tick();
    const report = cloud.heartbeats.at(-1)!.rooms.find((r) => r.roomId === ROOM)!;
    expect(report.error).toMatch(/Release 2 rejected.*hash_mismatch/);
    expect(report.releaseId).not.toBeNull(); // still running v1
  });

  it('never starts a room whose first release is tampered with, and reports why', async () => {
    cloud.assign(ROOM, model(), { tamper: true });
    const { gateway, host } = boot();
    gateway.start();
    await until(() => cloud.heartbeats.length >= 1);
    await gateway.tick();
    expect(host.ids()).toEqual([]);
    const report = cloud.heartbeats.at(-1)!.rooms.find((r) => r.roomId === ROOM)!;
    expect(report).toMatchObject({ status: 'unloaded', releaseId: null });
    expect(report.error).toContain('rejected');
    await until(() => cloud.telemetry.some((e) => e.type === 'manifest.rejected'));
  });

  it('rejects a release signed by a key that is not in its trusted set', async () => {
    cloud.assign(ROOM, model());
    // The cloud's config only vouches for some other key, so the signer ("test-key") is unknown.
    cloud.rotateKeys([{ keyId: 'someone-else', publicKeyPem: new FakeCloud().keys.publicKeyPem }]);
    const { gateway, host } = boot();
    await gateway.tick();
    await gateway.tick();
    expect(host.ids()).toEqual([]);
    const report = cloud.heartbeats.at(-1)!.rooms.find((r) => r.roomId === ROOM)!;
    expect(report.error).toMatch(/unknown_key/);
  });

  it('a pinned public key is trusted in addition to what the cloud says', async () => {
    cloud.assign(ROOM, model());
    cloud.rotateKeys([{ keyId: 'someone-else', publicKeyPem: new FakeCloud().keys.publicKeyPem }]);
    const { gateway, host } = boot({ pinnedPublicKey: cloud.keys.publicKeyPem });
    await gateway.tick();
    await gateway.tick();
    expect(host.ids()).toEqual([ROOM]);
  });

  it('a pinned key of the wrong key pair does not help a forged release', async () => {
    cloud.assign(ROOM, model());
    cloud.rotateKeys([{ keyId: 'someone-else', publicKeyPem: new FakeCloud().keys.publicKeyPem }]);
    const { gateway, host } = boot({ pinnedPublicKey: new FakeCloud().keys.publicKeyPem });
    await gateway.tick();
    await gateway.tick();
    expect(host.ids()).toEqual([]);
    expect(cloud.heartbeats.at(-1)!.rooms[0]!.error).toMatch(/bad_signature/);
  });
});

describe('offline operation', () => {
  it('boots rooms from the local cache with the cloud completely unreachable', async () => {
    cloud.assign(ROOM, model(), { name: 'Cached room' });
    const first = boot();
    first.gateway.start();
    await until(() => first.host.ids().includes(ROOM));
    first.gateway.stop();
    first.host.shutdown();
    first.store.close();
    running.length = 0;

    await cloud.stop();
    const second = boot({ enrollToken: undefined }, 'http://127.0.0.1:9');
    second.gateway.start();
    // Rooms are up straight away, before any cloud contact has succeeded.
    expect(second.host.ids()).toEqual([ROOM]);
    expect(second.host.get(ROOM)!.runtime.getSnapshot().roomName).toBe('Cached room');
    // ...and stay up while heartbeats fail.
    await wait(200);
    expect(second.host.ids()).toEqual([ROOM]);
  });

  it('refuses a cached manifest that was tampered with on disk', async () => {
    cloud.assign(ROOM, model(), { name: 'Cached room' });
    const first = boot();
    first.gateway.start();
    await until(() => first.host.ids().includes(ROOM));
    const raw = first.store.loadManifests()[0]!.raw as { manifest: { roomName: string } };
    raw.manifest.roomName = 'Edited on disk';
    first.store.saveManifest(raw as never);
    first.gateway.stop();
    first.host.shutdown();
    first.store.close();
    running.length = 0;

    const second = boot({ enrollToken: undefined }, 'http://127.0.0.1:9');
    second.gateway.start();
    expect(second.host.ids()).toEqual([]);
  });

  it('buffers telemetry while offline and replays it, in order, with original times', async () => {
    cloud.assign(ROOM, model());
    const { gateway, host, store } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));
    await until(() => cloud.telemetry.some((e) => e.type === 'gateway.started'));

    cloud.up = false;
    host.get(ROOM)!.runtime.dispatch({ type: 'activity.start', activityId: 'present' });
    await until(() => store.unsentCount() > 0);
    await gateway.tick(); // fails: cloud is down
    const during = store.unsentCount();
    expect(during).toBeGreaterThan(0);

    cloud.up = true;
    cloud.telemetry.length = 0;
    await gateway.tick();
    expect(store.unsentCount()).toBe(0);
    const statuses = cloud.telemetry.filter((e) => e.type === 'room.status').map((e) => e.data.status);
    expect(statuses[0]).toBe('starting');
    const times = cloud.telemetry.map((e) => e.at);
    expect([...times].sort()).toEqual(times);
  });
});

describe('telemetry', () => {
  it('reports status changes and started/stopped activities', async () => {
    cloud.assign(ROOM, model());
    const { gateway, host } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));
    host.get(ROOM)!.runtime.dispatch({ type: 'activity.start', activityId: 'present' });
    await until(() => host.get(ROOM)!.runtime.getSnapshot().status === 'on', 8000);
    await gateway.tick();
    const types = cloud.telemetry.map((e) => e.type);
    expect(types).toContain('room.status');
    expect(types).toContain('activity.started');
    expect(cloud.telemetry.find((e) => e.type === 'activity.started')!.data).toEqual({ activityId: 'present' });
  });
});
