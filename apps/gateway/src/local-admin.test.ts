import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, signManifest } from '@kestrel/crypto';
import { STARTER_TEMPLATES } from '@kestrel/model';
import { CloudClient } from './cloud';
import type { GatewayConfig } from './config';
import { Gateway, type LocalStatus } from './gateway';
import { loadAdminCode } from './local-admin';
import { silentLogger } from './log';
import { createPanelServer } from './panel-server';
import { RoomHost } from './room-host';
import { Store } from './store';
import { CREDENTIAL, ENROLL_TOKEN, FakeCloud } from './test-support/fake-cloud';

const ROOM = '33333333-3333-4333-8333-333333333331';
const PIN_ROOM = '33333333-3333-4333-8333-333333333332';
const CODE = 'ABCD-2345';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const keys = generateKeyPair();

function signedRoom() {
  return signManifest(
    {
      manifestVersion: 1,
      orgId: '11111111-1111-4111-8111-111111111111',
      roomId: ROOM,
      roomName: 'Boardroom',
      releaseId: '44444444-4444-4444-8444-444444444441',
      releaseNumber: 1,
      createdAt: new Date().toISOString(),
      model: structuredClone(STARTER_TEMPLATES[0]!.model),
      panel: { access: { mode: 'open', trustedIps: [] }, branding: {} },
    },
    { privateKeyPem: keys.privateKeyPem, keyId: 'k' },
  );
}

function signedPinRoom() {
  return signManifest(
    {
      manifestVersion: 1,
      orgId: '11111111-1111-4111-8111-111111111111',
      roomId: PIN_ROOM,
      roomName: 'Studio',
      releaseId: '44444444-4444-4444-8444-444444444442',
      releaseNumber: 1,
      createdAt: new Date().toISOString(),
      model: structuredClone(STARTER_TEMPLATES[0]!.model),
      panel: { access: { mode: 'pin', pinHash: 'salt:hash', trustedIps: [] }, branding: {} },
    },
    { privateKeyPem: keys.privateKeyPem, keyId: 'k' },
  );
}

const status = (over: Partial<LocalStatus> = {}): LocalStatus => ({
  version: '1.2.3',
  cloudHost: 'kestrel.example',
  installId: 'install-id-123',
  enrolment: 'unclaimed',
  name: null,
  lastContactAt: null,
  problem: null,
  control: true,
  bufferedEvents: 0,
  update: null,
  ...over,
});

describe('the local pages', () => {
  let host: RoomHost;
  let app: FastifyInstance;
  let time: number;
  const gateway = {
    status: vi.fn(() => status()),
    enrolWithToken: vi.fn(),
    reset: vi.fn(),
  };

  beforeEach(async () => {
    time = Date.now();
    vi.clearAllMocks();
    gateway.status.mockImplementation(() => status());
    gateway.enrolWithToken.mockResolvedValue({ ok: true, name: 'Site gateway' });
    gateway.reset.mockResolvedValue(undefined);
    host = new RoomHost('all', silentLogger, () => undefined);
    host.load(signedRoom());
    app = await createPanelServer({
      host,
      log: silentLogger,
      panelDir: '/nonexistent',
      admin: { gateway, adminCode: CODE, now: () => time },
    });
  });
  afterEach(async () => {
    await app.close();
    host.shutdown();
  });

  const post = (url: string, body: string, cookie?: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      payload: body,
      headers: { ...FORM, ...(cookie ? { cookie } : {}), ...headers },
    });

  async function unlock() {
    const res = await post('/admin/login', `code=${CODE}`);
    expect(res.statusCode).toBe(303);
    const set = String(res.headers['set-cookie']);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
    return set.split(';')[0]!;
  }

  it('lists the rooms with their panel links, open to anyone on the network', async () => {
    const res = await app.inject({ url: '/', headers: { host: '10.0.0.5:8080' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Boardroom');
    expect(res.body).toContain(`href="/room/${ROOM}"`);
    expect(res.body).toContain(`http://10.0.0.5:8080/room/${ROOM}`);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    // Browsers send "Origin: null" on form posts under no-referrer, which the origin check would refuse.
    expect(res.headers['referrer-policy']).toBe('same-origin');
  });

  it('names a PIN room without handing out its id or link', async () => {
    host.load(signedPinRoom());
    const res = await app.inject({ url: '/', headers: { host: '10.0.0.5:8080' } });
    expect(res.body).toContain('Studio');
    expect(res.body).toContain('PIN protected');
    expect(res.body).not.toContain(PIN_ROOM);
    // The open room on the same gateway is unaffected.
    expect(res.body).toContain(`href="/room/${ROOM}"`);
  });

  it('tells an unclaimed gateway’s installer what to give staff', async () => {
    const res = await app.inject({ url: '/' });
    expect(res.body).toContain('install-id-123');
    expect(res.body).toContain('claim this gateway');
  });

  it('never shows the admin code, a token or a credential on the open page', async () => {
    gateway.status.mockImplementation(() =>
      status({ enrolment: 'enrolled', name: 'Site gateway' }),
    );
    const res = await app.inject({ url: '/' });
    expect(res.body).not.toContain(CODE);
    expect(res.body).not.toContain('ABCD');
    expect(res.body).not.toContain(CREDENTIAL);
  });

  it('says plainly when an enrolled gateway has lost the cloud, and that rooms keep running', async () => {
    gateway.status.mockImplementation(() =>
      status({
        enrolment: 'enrolled',
        name: 'Site gateway',
        lastContactAt: new Date(time - 60 * 60_000).toISOString(),
        problem: 'The cloud cannot be reached from this machine.',
      }),
    );
    const res = await app.inject({ url: '/' });
    expect(res.body).toContain('Rooms keep running');
    expect(res.body).toContain('1 h ago');
  });

  it('escapes anything that came from outside', async () => {
    gateway.status.mockImplementation(() =>
      status({ enrolment: 'enrolled', name: '<script>alert(1)</script>' }),
    );
    const res = await app.inject({ url: '/', headers: { host: '"><script>x</script>' } });
    expect(res.body).not.toContain('<script>');
  });

  it('asks for the code before showing the admin page', async () => {
    const res = await app.inject({ url: '/admin' });
    expect(res.body).toContain('name="code"');
    expect(res.body).not.toContain('name="token"');
  });

  it('refuses a wrong code and locks out after five', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await post('/admin/login', 'code=WRONG-CODE');
      expect(res.statusCode).toBe(303);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    // Even the right code waits out the lock.
    const locked = await post('/admin/login', `code=${CODE}`);
    expect(locked.headers['set-cookie']).toBeUndefined();
    expect(locked.headers.location).toBe('/admin?msg=locked');
    time += 61_000;
    const later = await post('/admin/login', `code=${CODE}`);
    expect(later.headers['set-cookie']).toBeDefined();
  });

  it('accepts the code however it is typed', async () => {
    const res = await post('/admin/login', 'code=abcd+2345');
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('does not act on a token or a reset without the code', async () => {
    const token = await post('/admin/token', 'token=abc');
    const reset = await post('/admin/reset', 'confirm=RESET');
    expect(token.statusCode).toBe(303);
    expect(reset.statusCode).toBe(303);
    expect(gateway.enrolWithToken).not.toHaveBeenCalled();
    expect(gateway.reset).not.toHaveBeenCalled();
  });

  it('passes a token to the gateway and shows why it failed', async () => {
    const cookie = await unlock();
    const ok = await post('/admin/token', 'token=my-token', cookie);
    expect(gateway.enrolWithToken).toHaveBeenCalledWith('my-token');
    expect(ok.headers.location).toBe('/admin?msg=enrolled');

    gateway.enrolWithToken.mockResolvedValue({
      ok: false,
      message: 'The portal did not accept that token.',
    });
    const bad = await post('/admin/token', 'token=nope', cookie);
    expect(bad.statusCode).toBe(200);
    expect(bad.body).toContain('The portal did not accept that token.');
  });

  it('resets only when RESET is typed', async () => {
    const cookie = await unlock();
    const no = await post('/admin/reset', 'confirm=yes', cookie);
    expect(no.body).toContain('Type RESET');
    expect(gateway.reset).not.toHaveBeenCalled();
    const yes = await post('/admin/reset', 'confirm=RESET', cookie);
    expect(gateway.reset).toHaveBeenCalledTimes(1);
    expect(yes.headers.location).toBe('/admin?msg=reset');
  });

  it('ignores forms posted from another site', async () => {
    const cookie = await unlock();
    const res = await post('/admin/reset', 'confirm=RESET', cookie, {
      origin: 'http://evil.example',
      host: '10.0.0.5:8080',
    });
    expect(res.statusCode).toBe(403);
    expect(gateway.reset).not.toHaveBeenCalled();
  });

  it('locks again after half an hour, and when asked', async () => {
    const cookie = await unlock();
    expect((await app.inject({ url: '/admin', headers: { cookie } })).body).toContain(
      'name="token"',
    );
    time += 31 * 60_000;
    expect((await app.inject({ url: '/admin', headers: { cookie } })).body).toContain(
      'name="code"',
    );

    const again = await unlock();
    await post('/admin/logout', '', again);
    expect((await app.inject({ url: '/admin', headers: { cookie: again } })).body).toContain(
      'name="code"',
    );
  });
});

describe('the admin code file', () => {
  it('is made once and kept, in a shape that is easy to read out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-admin-'));
    try {
      const first = loadAdminCode(dir, silentLogger);
      expect(first.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
      expect(readFileSync(first.path, 'utf8').trim()).toBe(first.code);
      expect(loadAdminCode(dir, silentLogger).code).toBe(first.code);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('changing who a gateway belongs to', () => {
  let dir: string;
  let cloud: FakeCloud;
  const running: { gateway: Gateway; host: RoomHost; store: Store }[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kestrel-local-'));
    cloud = await new FakeCloud().start();
  });
  afterEach(async () => {
    for (const r of running.splice(0)) {
      r.gateway.stop();
      r.host.shutdown();
      r.store.close();
    }
    await cloud.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function boot() {
    const cfg: GatewayConfig = {
      cloudUrl: cloud.url,
      dataDir: dir,
      panelPort: 0,
      panelHost: '127.0.0.1',
      panelDir: '',
      simulate: 'all',
      logLevel: 'error',
      version: '0.0.0-test',
      enrollToken: ENROLL_TOKEN,
    };
    const store = new Store(join(dir, 'gateway.db'));
    const host = new RoomHost('all', silentLogger, (e) => store.enqueue(e));
    const gateway = new Gateway(cfg, store, new CloudClient(cloud.url), host, silentLogger);
    running.push({ gateway, host, store });
    return { gateway, host, store };
  }

  async function enrolledWithARoom() {
    const g = boot();
    cloud.assign(ROOM, structuredClone(STARTER_TEMPLATES[0]!.model));
    await g.gateway.tick();
    expect(g.host.ids()).toEqual([ROOM]);
    expect(g.gateway.status().enrolment).toBe('enrolled');
    return g;
  }

  it('a token that is refused changes nothing', async () => {
    const { gateway, host, store } = await enrolledWithARoom();
    const res = await gateway.enrolWithToken('not-a-real-token-0000');
    expect(res).toMatchObject({ ok: false });
    expect(store.get('credential')).toBe(CREDENTIAL);
    expect(host.ids()).toEqual([ROOM]);
  });

  it('an empty token is refused without asking the cloud', async () => {
    const { gateway } = boot();
    const before = cloud.enrols.length;
    expect(await gateway.enrolWithToken('   ')).toMatchObject({ ok: false });
    expect(cloud.enrols.length).toBe(before);
  });

  it('a good token moves the gateway: the old organisation’s rooms stop and its events are dropped', async () => {
    const { gateway, host, store } = await enrolledWithARoom();
    gateway.record({ type: 'gateway.started', data: { old: true } });
    expect(store.unsentCount()).toBeGreaterThan(0);
    cloud.unassign(ROOM);
    const res = await gateway.enrolWithToken(ENROLL_TOKEN);
    expect(res).toMatchObject({ ok: true, name: 'Test gateway' });
    expect(host.ids()).toEqual([]);
    expect(store.loadManifests()).toEqual([]);
    expect(store.get('credential')).toBe(CREDENTIAL);
    expect(gateway.status().enrolment).toBe('enrolled');
    await gateway.tick();
    expect(cloud.telemetry.some((e) => (e.data as { old?: boolean }).old)).toBe(false);
  });

  it('a reset forgets the organisation and announces as a new unclaimed install', async () => {
    const { gateway, host, store } = await enrolledWithARoom();
    cloud.announceReply = { status: 'unclaimed', retrySeconds: 60 };
    await gateway.reset();
    expect(host.ids()).toEqual([]);
    expect(store.loadManifests()).toEqual([]);
    expect(store.get('credential')).toBeNull();
    expect(store.keysWithPrefix('bindings:')).toEqual([]);
    expect(store.keysWithPrefix('deployment:')).toEqual([]);

    await gateway.tick();
    expect(cloud.announces).toHaveLength(1);
    const first = cloud.announces[0]!.installId;
    expect(gateway.status()).toMatchObject({ enrolment: 'unclaimed', installId: first });

    // A second reset is another new install, so an old claim cannot be reused.
    await gateway.reset();
    await gateway.tick();
    expect(cloud.announces).toHaveLength(2);
    expect(cloud.announces[1]!.installId).not.toBe(first);
  });

  it('a reset does not use the token in the settings again', async () => {
    const { gateway } = await enrolledWithARoom();
    const enrols = cloud.enrols.length;
    await gateway.reset();
    await gateway.tick();
    expect(cloud.enrols.length).toBe(enrols);
  });
});
