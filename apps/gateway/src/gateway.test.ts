import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, addAvoipSystem, type RoomModel } from '@kestrel/model';
import { CloudClient } from './cloud';
import type { GatewayConfig } from './config';
import { Gateway } from './gateway';
import { silentLogger } from './log';
import { RoomHost, type SimulateMode } from './room-host';
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

function boot(over: Partial<GatewayConfig> = {}, url = cloud.url, mode: SimulateMode = 'all') {
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
  const host = new RoomHost(mode, silentLogger, (e) => store.enqueue(e));
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
    expect(last.rooms).toHaveLength(1);
    expect(last.rooms[0]).toMatchObject({
      roomId: ROOM,
      releaseId: signed.manifest.releaseId,
      status: 'off',
    });
    expect(last.rooms[0]!.deployment).toMatchObject({ stage: 'active' });
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

  it('forgets a credential the cloud no longer recognises and re-enrols on its own', async () => {
    cloud.assign(ROOM, model());
    const { gateway, host, store } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));
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

  it('picks up rotated public keys from the config', async () => {
    cloud.assign(ROOM, model());
    const { gateway, host, store } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));
    const next = { keyId: 'k2', publicKeyPem: cloud.keys.publicKeyPem };
    cloud.rotateKeys([...cloud.publicKeys, next]);
    await gateway.tick();
    expect(store.getJson<{ keyId: string }[]>('publicKeys')!.map((k) => k.keyId)).toEqual([
      'test-key',
      'k2',
    ]);
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
    // Two ticks by hand: the first learns the assignment and refuses it, the second reports that.
    // (Not start(): its own background tick could overlap these and make the last heartbeat a stale one.)
    await gateway.tick();
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
    const statuses = cloud.telemetry
      .filter((e) => e.type === 'room.status')
      .map((e) => e.data.status);
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
    expect(cloud.telemetry.find((e) => e.type === 'activity.started')!.data).toEqual({
      activityId: 'present',
    });
  });

  it('logs a device.feedback event for each feedback field that changes', async () => {
    cloud.assign(ROOM, model());
    const { gateway, host } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));
    host.get(ROOM)!.runtime.dispatch({ type: 'activity.start', activityId: 'present' });
    await until(() => host.get(ROOM)!.runtime.getSnapshot().status === 'on', 8000);
    await gateway.tick();
    const feedback = cloud.telemetry.filter((e) => e.type === 'device.feedback');
    // Something turned on: displays report power going from off to on.
    expect(
      feedback.some(
        (e) =>
          (e.data as { field: string; value: unknown }).field === 'power' &&
          (e.data as { value: unknown }).value === 'on',
      ),
    ).toBe(true);
    for (const e of feedback)
      expect(e.data).toMatchObject({
        deviceId: expect.any(String),
        name: expect.any(String),
        field: expect.any(String),
      });
  });

  it('keeps logging feedback once control is switched off, since it never sends anything', async () => {
    cloud.assign(ROOM, model());
    const { gateway, host } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));
    host.get(ROOM)!.runtime.dispatch({ type: 'activity.start', activityId: 'present' });
    await until(() => host.get(ROOM)!.runtime.getSnapshot().status === 'on', 8000);
    await gateway.tick();
    cloud.telemetry.length = 0;
    host.setControl(false);
    // `bus` is the room's raw device connection, not what dispatch runs commands through: sending on
    // it directly stands in for some other controller changing the device, which Kestrel only watches.
    await host.get(ROOM)!.bus.send('display1', { type: 'power', on: false });
    await gateway.tick();
    const feedback = cloud.telemetry.filter((e) => e.type === 'device.feedback');
    expect(
      feedback.some(
        (e) =>
          (e.data as { deviceId: string }).deviceId === 'display1' &&
          (e.data as { field: string }).field === 'power' &&
          (e.data as { value: unknown }).value === 'off',
      ),
    ).toBe(true);
  });
});

describe('staged deployments', () => {
  const servers: Server[] = [];
  afterEach(() => servers.splice(0).forEach((x) => x.close()));

  /** The starter room with no device control, so nothing needs a real driver. */
  const plain = (): RoomModel => {
    const m = model();
    for (const d of m.devices) delete d.control;
    return m;
  };
  /** The plain room with its DSP configured as a real TCP device at the given port. */
  const withDsp = (port: number): RoomModel => {
    const m = plain();
    const dsp = m.devices.find((d) => d.id === 'dsp')!;
    dsp.control = { kind: 'generic', protocol: 'tcp' };
    dsp.settings = { host: '127.0.0.1', port, timeoutMs: 200, commands: {} };
    return m;
  };
  const listening = () =>
    new Promise<number>((resolve) => {
      const server = createServer((socket) => socket.on('error', () => undefined));
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
  const deadPort = async () => {
    const port = await listening();
    await new Promise((r) => servers.pop()!.close(r));
    return port;
  };
  const reportFor = (roomId = ROOM) =>
    cloud.heartbeats.at(-1)?.rooms.find((r) => r.roomId === roomId);

  it('walks a release through every stage and reports them in order', async () => {
    cloud.assign(ROOM, plain());
    const { gateway, host } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));
    await until(() => reportFor()?.deployment?.stage === 'active');
    const d = reportFor()!.deployment!;
    expect(d.history.map((h) => h.stage)).toEqual([
      'downloading',
      'verifying',
      'staging',
      'health_check',
      'active',
    ]);
    expect(new Date(d.history[0]!.at).getTime()).toBeLessThanOrEqual(
      new Date(d.history.at(-1)!.at).getTime(),
    );
    expect(d.error).toBeUndefined();
  });

  it('tells the cloud the result straight away instead of waiting a heartbeat', async () => {
    cloud.assign(ROOM, plain());
    const { gateway, host } = boot();
    await gateway.tick();
    expect(host.ids()).toEqual([ROOM]);
    expect(reportFor()?.deployment?.stage).toBe('active');
  });

  it('activates a release whose devices answer', async () => {
    cloud.assign(ROOM, withDsp(await listening()));
    const { gateway, host } = boot({ healthTimeoutMs: 2000 }, cloud.url, 'missing');
    await gateway.tick();
    expect(host.ids()).toEqual([ROOM]);
    expect(reportFor()?.deployment?.stage).toBe('active');
  });

  it('activates a release that replaces a running one even when it cannot reach one of its devices', async () => {
    cloud.assign(ROOM, plain(), { name: 'Good v1' });
    const { gateway, host } = boot({ healthTimeoutMs: 500 }, cloud.url, 'missing');
    await gateway.tick();
    const v1 = host.get(ROOM)!.runtime;

    cloud.assign(ROOM, withDsp(await deadPort()), { name: 'Bad v2' });
    await gateway.tick();
    // A device not answering is a monitoring problem, not a reason to refuse the release: it swaps
    // in and goes active, and the usual device_offline incident picks up the DSP once it reports.
    expect(host.get(ROOM)!.runtime).not.toBe(v1);
    expect(host.get(ROOM)!.runtime.getSnapshot().roomName).toBe('Bad v2');
    const d = reportFor()!.deployment!;
    expect(d.stage).toBe('active');
    expect(d.history.map((h) => h.stage)).toEqual([
      'downloading',
      'verifying',
      'staging',
      'health_check',
      'active',
    ]);
    expect(d.error).toBeUndefined();
  });

  it('activates the very first release even when it cannot reach its devices', async () => {
    cloud.assign(ROOM, withDsp(await deadPort()));
    const { gateway, host } = boot({ healthTimeoutMs: 300 }, cloud.url, 'missing');
    await gateway.tick();
    expect(host.ids()).toEqual([ROOM]);
    expect(reportFor()?.deployment?.stage).toBe('active');
  });

  it('does not retry a refused deployment, but does retry when the cloud starts a new one', async () => {
    cloud.assign(ROOM, plain(), { name: 'Good v1' });
    const { gateway } = boot();
    await gateway.tick();
    cloud.assign(ROOM, plain(), { name: 'Bad v2', tamper: true });
    await gateway.tick();
    const fetched = cloud.manifestFetches.length;
    await gateway.tick();
    await gateway.tick();
    expect(cloud.manifestFetches).toHaveLength(fetched);

    cloud.redeploy(ROOM);
    await gateway.tick();
    expect(cloud.manifestFetches).toHaveLength(fetched + 1);
    expect(reportFor()?.deployment?.stage).toBe('rolled_back');
  });

  it('remembers a refused deployment across a restart', async () => {
    cloud.assign(ROOM, plain(), { name: 'Good v1' });
    const first = boot();
    await first.gateway.tick();
    cloud.assign(ROOM, plain(), { name: 'Bad v2', tamper: true });
    await first.gateway.tick();
    const fetched = cloud.manifestFetches.length;
    first.gateway.stop();
    first.host.shutdown();
    first.store.close();
    running.length = 0;

    const second = boot({ enrollToken: undefined }, cloud.url, 'missing');
    second.gateway.start();
    await second.gateway.tick();
    expect(cloud.manifestFetches).toHaveLength(fetched);
    expect(second.host.get(ROOM)!.runtime.getSnapshot().roomName).toBe('Good v1');
    expect(reportFor()?.deployment?.stage).toBe('rolled_back');
  });

  it('a bad signature is a refused deployment too, and the running release stays', async () => {
    cloud.assign(ROOM, plain(), { name: 'Good v1' });
    const { gateway, host } = boot();
    await gateway.tick();
    cloud.assign(ROOM, plain(), { name: 'Good v2', tamper: true });
    await gateway.tick();
    expect(host.get(ROOM)!.runtime.getSnapshot().roomName).toBe('Good v1');
    const d = reportFor()!.deployment!;
    expect(d.stage).toBe('rolled_back');
    expect(d.history.map((h) => h.stage)).toEqual(['downloading', 'verifying', 'rolled_back']);
    expect(d.error).toMatch(/hash_mismatch/);
  });

  it('counts a release already running from the cache as the deployment that asked for it', async () => {
    cloud.assign(ROOM, plain());
    const first = boot();
    await first.gateway.tick();
    first.gateway.stop();
    first.host.shutdown();
    first.store.close();
    running.length = 0;

    cloud.redeploy(ROOM);
    const second = boot({ enrollToken: undefined });
    second.gateway.start();
    await second.gateway.tick();
    const fetched = cloud.manifestFetches.length;
    await second.gateway.tick();
    expect(cloud.manifestFetches).toHaveLength(fetched);
    expect(reportFor()?.deployment?.stage).toBe('active');
  });

  it('forgets a rooms deployment when the room is unassigned', async () => {
    cloud.assign(ROOM, plain());
    const { gateway, store } = boot();
    await gateway.tick();
    expect(store.keysWithPrefix('deployment:')).toHaveLength(1);
    cloud.unassign(ROOM);
    await gateway.tick();
    expect(store.keysWithPrefix('deployment:')).toHaveLength(0);
  });
});

describe('bindings', () => {
  const servers: Server[] = [];
  afterEach(() => servers.splice(0).forEach((x) => x.close()));

  const listening = () =>
    new Promise<number>((resolve) => {
      const server = createServer((socket) => socket.on('error', () => undefined));
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
  /** The starter room whose DSP is a real TCP device with its address left out of the design. */
  const design = (): RoomModel => {
    const m = model();
    for (const d of m.devices) delete d.control;
    const dsp = m.devices.find((d) => d.id === 'dsp')!;
    dsp.control = { kind: 'generic', protocol: 'tcp' };
    dsp.settings = { timeoutMs: 200, commands: {} };
    return m;
  };
  const dspAt = (port: number) => ({ dsp: { host: '127.0.0.1', port } });
  const reportFor = () => cloud.heartbeats.at(-1)?.rooms.find((r) => r.roomId === ROOM);

  it('says it shows bookings, and keeps the ones the cloud sends', async () => {
    const { gateway } = boot();
    cloud.schedules = [
      {
        roomId: ROOM,
        meetings: [
          {
            id: 'm1',
            title: 'Budget review',
            start: '2026-09-28T09:00:00.000Z',
            end: '2026-09-28T10:00:00.000Z',
            private: false,
          },
        ],
      },
    ];
    await gateway.tick();
    expect(cloud.heartbeats.at(-1)!.features).toContain('schedule');
    expect(gateway.bookings.get(ROOM)?.map((m) => m.title)).toEqual(['Budget review']);
  });

  it('says it can fetch bindings', async () => {
    const { gateway } = boot();
    await gateway.tick();
    expect(cloud.heartbeats.at(-1)!.features).toContain('bindings');
  });

  it('runs a release that keeps its addresses apart by fetching them', async () => {
    cloud.assign(ROOM, design(), { external: true });
    cloud.setBindings(ROOM, dspAt(await listening()));
    const { gateway, host } = boot({ healthTimeoutMs: 1000 }, cloud.url, 'missing');
    await gateway.tick();
    expect(host.ids()).toEqual([ROOM]);
    expect(host.get(ROOM)!.bindings?.version).toBe(1);
    await gateway.tick();
    expect(reportFor()).toMatchObject({ bindingsVersion: 1, deployment: { stage: 'active' } });
  });

  it('refuses a release that needs bindings the cloud does not have', async () => {
    cloud.assign(ROOM, design(), { external: true });
    const { gateway, host } = boot();
    await gateway.tick();
    expect(host.ids()).toEqual([]);
    await gateway.tick();
    expect(reportFor()!.deployment).toMatchObject({ stage: 'failed' });
    expect(reportFor()!.error).toMatch(/no addresses/);
  });

  it('refuses bindings that were changed after signing', async () => {
    cloud.assign(ROOM, design(), { external: true });
    cloud.setBindings(ROOM, dspAt(1), { tamper: true });
    const { gateway, host } = boot();
    await gateway.tick();
    expect(host.ids()).toEqual([]);
    await gateway.tick();
    expect(reportFor()!.error).toMatch(/signature check.*hash_mismatch/);
  });

  it('applies a changed address with no new release, even when the new one cannot be reached', async () => {
    const first = await listening();
    cloud.assign(ROOM, design(), { external: true });
    cloud.setBindings(ROOM, dspAt(first));
    const { gateway, host } = boot({ healthTimeoutMs: 500 }, cloud.url, 'missing');
    await gateway.tick();
    const v1 = host.get(ROOM)!.runtime;
    const fetched = cloud.manifestFetches.length;

    const dead = await listening();
    servers.pop()!.close();
    cloud.setBindings(ROOM, dspAt(dead));
    await gateway.tick();
    // A dead address is a monitoring problem, not a reason to refuse the rebind: it applies anyway.
    expect(host.get(ROOM)!.runtime).not.toBe(v1);
    expect(host.get(ROOM)!.bindings?.version).toBe(2);
    await gateway.tick();
    expect(reportFor()!.error).toBeUndefined();

    const second = await listening();
    cloud.setBindings(ROOM, dspAt(second));
    await gateway.tick();
    expect(host.get(ROOM)!.bindings?.version).toBe(3);
    expect(cloud.manifestFetches).toHaveLength(fetched); // no new release was needed
    await gateway.tick();
    expect(reportFor()!.error).toBeUndefined();
  });

  it('boots from the cache with the saved bindings while the cloud is unreachable', async () => {
    cloud.assign(ROOM, design(), { external: true });
    cloud.setBindings(ROOM, dspAt(await listening()));
    const first = boot({ healthTimeoutMs: 1000 }, cloud.url, 'missing');
    await first.gateway.tick();
    first.gateway.stop();
    first.host.shutdown();
    first.store.close();
    running.length = 0;

    const second = boot({ enrollToken: undefined }, 'http://127.0.0.1:9', 'missing');
    second.gateway.start();
    expect(second.host.ids()).toEqual([ROOM]);
    expect(second.host.get(ROOM)!.bindings?.version).toBe(1);
  });

  it('does not start a cached release that needs bindings when the saved copy was edited on disk', async () => {
    cloud.assign(ROOM, design(), { external: true });
    cloud.setBindings(ROOM, dspAt(await listening()));
    const first = boot({ healthTimeoutMs: 1000 }, cloud.url, 'missing');
    await first.gateway.tick();
    const raw = first.store.getJson<{ payload: { devices: Record<string, unknown> } }>(
      `bindings:${ROOM}`,
    )!;
    raw.payload.devices = { dsp: { host: '6.6.6.6' } };
    first.store.setJson(`bindings:${ROOM}`, raw);
    first.gateway.stop();
    first.host.shutdown();
    first.store.close();
    running.length = 0;

    const second = boot({ enrollToken: undefined }, 'http://127.0.0.1:9', 'missing');
    second.gateway.start();
    expect(second.host.ids()).toEqual([]);
  });

  it('forgets a rooms bindings when the room is unassigned', async () => {
    cloud.assign(ROOM, design(), { external: true });
    cloud.setBindings(ROOM, dspAt(await listening()));
    const { gateway, store } = boot({ healthTimeoutMs: 1000 }, cloud.url, 'missing');
    await gateway.tick();
    expect(store.get(`bindings:${ROOM}`)).not.toBeNull();
    cloud.unassign(ROOM);
    await gateway.tick();
    expect(store.get(`bindings:${ROOM}`)).toBeNull();
  });

  it('two rooms that share a device use one connection to it', async () => {
    const connections: number[] = [];
    const server = createServer((socket) => {
      connections.push(1);
      socket.on('error', () => undefined);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const shared = {
      dsp: { siteDeviceId: '77777777-7777-4777-8777-777777777771', exclusive: false },
    };
    for (const room of [ROOM, ROOM2]) {
      cloud.assign(room, design(), { external: true });
      cloud.setBindings(room, dspAt(port), { shared });
    }
    const { gateway, host } = boot({ healthTimeoutMs: 1000 }, cloud.url, 'missing');
    await gateway.tick();
    expect(host.ids().sort()).toEqual([ROOM, ROOM2]);
    await wait(200);
    expect(connections).toHaveLength(1);
    expect(host.shared.size).toBe(1);
    // Both rooms see the device online.
    expect(host.reports().every((r) => r.devices.find((d) => d.deviceId === 'dsp')!.online)).toBe(
      true,
    );
    // Unloading one keeps the connection for the other; unloading both closes it.
    host.unload(ROOM);
    expect(host.shared.size).toBe(1);
    host.unload(ROOM2);
    expect(host.shared.size).toBe(0);
  });

  it('a room that is not told a device is shared keeps its own connection', async () => {
    const connections: number[] = [];
    const server = createServer((socket) => {
      connections.push(1);
      socket.on('error', () => undefined);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    for (const room of [ROOM, ROOM2]) {
      cloud.assign(room, design(), { external: true });
      cloud.setBindings(room, dspAt(port));
    }
    const { gateway, host } = boot({ healthTimeoutMs: 1000 }, cloud.url, 'missing');
    await gateway.tick();
    await wait(200);
    expect(host.ids()).toHaveLength(2);
    expect(connections).toHaveLength(2);
    expect(host.shared.size).toBe(0);
  });

  it('runs an AVoIP system: the room builds the virtual switcher over its endpoints and they answer', async () => {
    const unit = createHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/Device/StreamTransmit')
        res.end(JSON.stringify({ Device: { StreamTransmit: { Streams: [{ UUID: 'u1' }] } } }));
      else if (req.url === '/Device/AvRouting')
        res.end(JSON.stringify({ Device: { AvRouting: { Routes: [{ VideoSource: 'u1' }] } } }));
      else
        res.end(
          JSON.stringify({
            Device: { AudioVideoInputOutput: { Inputs: [{ Ports: [{ IsSyncDetected: true }] }] } },
          }),
        );
    });
    await new Promise<void>((r) => unit.listen(0, '127.0.0.1', r));
    const port = (unit.address() as { port: number }).port;
    const m = design();
    for (const d of m.devices) delete d.control;
    const made = addAvoipSystem(m, { family: 'crestron-nvx', encoders: 1, decoders: 1 });
    if (!made.ok) throw new Error(made.message);
    const endpoint = {
      host: '127.0.0.1',
      port,
      protocol: 'http',
      username: 'admin',
      password: 'x',
    };
    cloud.assign(ROOM, m, { external: true });
    cloud.setBindings(ROOM, { [made.encoderIds![0]!]: endpoint, [made.decoderIds![0]!]: endpoint });
    const { gateway, host } = boot({ healthTimeoutMs: 3000 }, cloud.url, 'missing');
    await gateway.tick();
    expect(host.ids()).toEqual([ROOM]);
    const online = () =>
      Object.fromEntries(host.reports()[0]!.devices.map((d) => [d.deviceId, d.online]));
    await until(() => online()[made.switcherId!] === true);
    expect(online()).toMatchObject({
      [made.encoderIds![0]!]: true,
      [made.decoderIds![0]!]: true,
      [made.switcherId!]: true,
    });
    unit.close();
  });
});
