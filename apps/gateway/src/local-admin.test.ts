import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudClient } from './cloud';
import type { GatewayConfig } from './config';
import { Gateway, type LocalStatus } from './gateway';
import { loadAdminCode } from './local-admin';
import { silentLogger } from './log';
import { createLocalServer } from './local-server';
import { Store } from './store';
import { CREDENTIAL, ENROLL_TOKEN, FakeCloud } from './test-support/fake-cloud';

const CODE = 'ABCD-2345';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const DEV = '00000000-0000-4000-8000-000000000001';

const status = (over: Partial<LocalStatus> = {}): LocalStatus => ({
  version: '1.2.3',
  cloudHost: 'kestrel.example',
  installId: 'install-id-123',
  enrolment: 'unclaimed',
  name: null,
  lastContactAt: null,
  problem: null,
  bufferedEvents: 0,
  devices: 0,
  update: null,
  ...over,
});

describe('the local pages', () => {
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
    app = await createLocalServer({
      log: silentLogger,
      admin: { gateway, log: silentLogger, adminCode: CODE, now: () => time },
    });
  });
  afterEach(async () => {
    await app.close();
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
    expect(set).toContain('SameSite=Lax');
    return set.split(';')[0]!;
  }

  it('is open to anyone on the network, with safe headers', async () => {
    gateway.status.mockImplementation(() => status({ enrolment: 'enrolled', name: 'Site gateway', devices: 3 }));
    const open = await app.inject({ url: '/', headers: { host: '10.0.0.5:8080' } });
    // Anyone on the network sees only whether it works, never its name, version or devices.
    expect(open.body).not.toContain('Site gateway');
    expect(open.body).not.toContain('Devices watched');
    const res = await app.inject({
      url: '/',
      headers: { host: '10.0.0.5:8080', cookie: await unlock() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Site gateway');
    expect(res.body).toContain('Devices watched');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    // Browsers send "Origin: null" on form posts under no-referrer, which the origin check would refuse.
    expect(res.headers['referrer-policy']).toBe('same-origin');
  });

  it('answers /health, and refuses a name the gateway is not meant to be reached by', async () => {
    expect((await app.inject({ url: '/health', headers: { host: 'evil.example.com' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/', headers: { host: 'evil.example.com' } })).statusCode).toBe(421);
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

  it('says plainly when an enrolled gateway has lost the cloud, and that devices keep being watched', async () => {
    gateway.status.mockImplementation(() =>
      status({
        enrolment: 'enrolled',
        name: 'Site gateway',
        lastContactAt: new Date(time - 60 * 60_000).toISOString(),
        problem: 'The cloud cannot be reached from this machine.',
      }),
    );
    const open = await app.inject({ url: '/' });
    expect(open.body).toContain('Devices keep being watched');
    expect(open.body).not.toContain('1 h ago');
    const res = await app.inject({ url: '/', headers: { cookie: await unlock() } });
    expect(res.body).toContain('Devices keep being watched');
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
    expect(ok.headers.location).toBe('/?msg=enrolled');

    gateway.enrolWithToken.mockResolvedValue({
      ok: false,
      message: 'The portal did not accept that token.',
    });
    // A successful enrolment ends every sign-in (the gateway has a new organisation), so sign in again.
    expect((await post('/admin/token', 'token=again', cookie)).headers.location).toBe('/admin');
    const bad = await post('/admin/token', 'token=nope', await unlock());
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
    expect(yes.headers.location).toBe('/?msg=reset');
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
  const running: { gateway: Gateway; store: Store }[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kestrel-local-'));
    cloud = await new FakeCloud().start();
  });
  afterEach(async () => {
    for (const r of running.splice(0)) {
      r.gateway.stop();
      r.gateway.devices.shutdown();
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
      logLevel: 'error',
      version: '0.0.0-test',
      enrollToken: ENROLL_TOKEN,
    };
    const store = new Store(join(dir, 'gateway.db'));
    const gateway = new Gateway(cfg, store, new CloudClient(cloud.url), silentLogger);
    running.push({ gateway, store });
    return { gateway, store };
  }

  async function enrolledWithADevice() {
    cloud.deviceSet = {
      version: 'v1',
      devices: [
        {
          id: DEV,
          name: 'Lobby display',
          category: 'display',
          control: { kind: 'generic', protocol: 'pjlink' },
          settings: { host: '127.0.0.1', port: 9 },
        },
      ],
    };
    const g = boot();
    await g.gateway.tick();
    expect(g.gateway.devices.size).toBe(1);
    expect(g.gateway.status().enrolment).toBe('enrolled');
    return g;
  }

  it('a token that is refused changes nothing', async () => {
    const { gateway, store } = await enrolledWithADevice();
    const res = await gateway.enrolWithToken('not-a-real-token-0000');
    expect(res).toMatchObject({ ok: false });
    expect(store.get('credential')).toBe(CREDENTIAL);
    expect(gateway.devices.size).toBe(1);
  });

  it('an empty token is refused without asking the cloud', async () => {
    const { gateway } = boot();
    const before = cloud.enrols.length;
    expect(await gateway.enrolWithToken('   ')).toMatchObject({ ok: false });
    expect(cloud.enrols.length).toBe(before);
  });

  it('a good token moves the gateway: the old organisation’s devices stop and its events are dropped', async () => {
    const { gateway, store } = await enrolledWithADevice();
    gateway.record({ type: 'gateway.started', data: { old: true } });
    expect(store.unsentCount()).toBeGreaterThan(0);
    cloud.deviceSet = null;
    const res = await gateway.enrolWithToken(ENROLL_TOKEN);
    expect(res).toMatchObject({ ok: true, name: 'Test gateway' });
    expect(gateway.devices.size).toBe(0);
    expect(store.get('credential')).toBe(CREDENTIAL);
    expect(gateway.status().enrolment).toBe('enrolled');
    await gateway.tick();
    expect(cloud.telemetry.some((e) => (e.data as { old?: boolean }).old)).toBe(false);
  });

  it('a reset forgets the organisation and announces as a new unclaimed install', async () => {
    const { gateway, store } = await enrolledWithADevice();
    cloud.announceReply = { status: 'unclaimed', retrySeconds: 60 };
    await gateway.reset();
    expect(gateway.devices.size).toBe(0);
    expect(store.get('credential')).toBeNull();
    expect(store.get('deviceSet')).toBeNull();

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
    const { gateway } = await enrolledWithADevice();
    const enrols = cloud.enrols.length;
    await gateway.reset();
    await gateway.tick();
    expect(cloud.enrols.length).toBe(enrols);
  });
});
