import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostFacts, runChecks, tailLog, type CheckResult } from './diagnostics';
import type { GatewaySnapshot, LocalStatus } from './gateway';
import { silentLogger } from './log';
import { createLocalServer } from './local-server';

const CODE = 'ABCD-2345';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

const status = (over: Partial<LocalStatus> = {}): LocalStatus => ({
  version: '1.2.3',
  cloudHost: 'kestrel.example',
  installId: 'install-id-123',
  enrolment: 'enrolled',
  name: 'Level 2 gateway',
  lastContactAt: new Date().toISOString(),
  problem: null,
  bufferedEvents: 0,
  devices: 2,
  update: null,
  ...over,
});

const snapshot = (over: Partial<GatewaySnapshot> = {}): GatewaySnapshot => ({
  startedAt: new Date().toISOString(),
  uptimeSeconds: 7200,
  gatewayId: '99999999-9999-4999-8999-999999999999',
  heartbeatSeconds: 30,
  checkIns: [
    { at: new Date().toISOString(), ok: true, ms: 120 },
    { at: new Date(Date.now() - 60_000).toISOString(), ok: false, ms: 15000, error: 'Could not reach the cloud' },
  ],
  consecutiveFailures: 0,
  clockSkewMs: 500,
  configVersion: '12',
  deviceSetVersion: 'v3',
  localUrls: ['http://10.0.0.5:8080'],
  tls: false,
  trustedKeys: 1,
  devices: [
    { deviceId: 'd1', name: 'Projector', online: true, driver: 'pjlink', latency: { sent: 5, ok: 5, avgMs: 4 } },
    { deviceId: 'd2', name: 'Lectern DSP', online: false, offlineForMs: 600_000, driver: 'qsys', latency: { sent: 5, ok: 0 } },
  ],
  ...over,
});

describe('the troubleshooting pages', () => {
  let app: FastifyInstance;
  let dir: string;
  let snap: GatewaySnapshot;
  const gateway = { status: vi.fn(), enrolWithToken: vi.fn(), reset: vi.fn(), record: vi.fn() };
  const fakeChecks = vi.fn(async (): Promise<CheckResult[]> => [
    { id: 'dns', label: 'Name lookup', status: 'ok', detail: 'kestrel.example resolves to 1.2.3.4.', ms: 5 },
    { id: 'https', label: 'Connection to Kestrel', status: 'fail', detail: 'Could not connect (ECONNREFUSED).' },
  ]);

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'kg-pages-'));
    mkdirSync(join(dir, 'logs'));
    writeFileSync(
      join(dir, 'logs', 'gateway.log'),
      [
        JSON.stringify({ time: '2026-10-07T10:00:00.000+11:00', level: 'info', message: 'Enrolled with the cloud' }),
        JSON.stringify({ time: '2026-10-07T10:01:00.000+11:00', level: 'warn', message: 'Cloud sync failed <b>x</b>', error: 'ECONNREFUSED' }),
        JSON.stringify({ time: '2026-10-07T10:02:00.000+11:00', level: 'error', message: 'Something broke' }),
        'not json at all',
      ].join('\n') + '\n',
    );
    snap = snapshot();
    gateway.status.mockImplementation(() => status());
    app = await createLocalServer({
      log: silentLogger,
      admin: {
        gateway,
        log: silentLogger,
        adminCode: CODE,
        diagnostics: {
          snapshot: () => snap,
          dataDir: dir,
          cloudUrl: 'https://kestrel.example',
          logFile: join(dir, 'logs', 'gateway.log'),
          runChecks: fakeChecks,
        },
      },
    });
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function cookie() {
    const res = await app.inject({ method: 'POST', url: '/admin/login', payload: `code=${CODE}`, headers: FORM });
    return String(res.headers['set-cookie']).split(';')[0]!;
  }
  const get = async (url: string) => app.inject({ url, headers: { cookie: await cookie() } });

  it('send a stranger back to the front page', async () => {
    for (const url of ['/devices', '/diagnostics', '/logs', '/support-bundle']) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/');
    }
    const run = await app.inject({ method: 'POST', url: '/diagnostics/run', headers: FORM, payload: '' });
    expect(run.statusCode).toBe(303);
    expect(fakeChecks).not.toHaveBeenCalled();
  });

  it('list devices with the ones not answering first', async () => {
    const res = await get('/devices');
    expect(res.statusCode).toBe(200);
    expect(res.body.indexOf('Lectern DSP')).toBeLessThan(res.body.indexOf('Projector'));
    expect(res.body).toContain('Not answering for 10 minutes');
    expect(res.body).toContain('no reply');
    expect(res.body).toContain('1 of 2 answering');
  });

  it('say what to do when the cloud cannot be reached, and when the clock is wrong', async () => {
    gateway.status.mockImplementation(() =>
      status({
        lastContactAt: new Date(Date.now() - 3600_000).toISOString(),
        problem: 'The cloud cannot be reached from this machine.',
      }),
    );
    snap = snapshot({ clockSkewMs: 5 * 60_000 });
    const res = await get('/');
    expect(res.body).toContain('port 443');
    expect(res.body).toContain('Diagnostics');
    expect(res.body).toContain('clock is about 300 seconds behind');
    expect(res.body).toContain('1 device is not answering');
  });

  it('show how the last check-ins went', async () => {
    const res = await get('/');
    expect(res.body).toContain('Recent check-ins');
    expect(res.body).toContain('Could not reach the cloud');
  });

  it('run the checks, show what they found, and slow down repeat runs', async () => {
    const c = await cookie();
    const first = await app.inject({ method: 'POST', url: '/diagnostics/run', headers: { ...FORM, cookie: c }, payload: '' });
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain('Name lookup');
    expect(first.body).toContain('ECONNREFUSED');
    expect(fakeChecks).toHaveBeenCalledTimes(1);
    const again = await app.inject({ method: 'POST', url: '/diagnostics/run', headers: { ...FORM, cookie: c }, payload: '' });
    expect(again.body).toContain('ran a moment ago');
    expect(fakeChecks).toHaveBeenCalledTimes(1);
    // The result stays on the page for the next visit.
    expect((await app.inject({ url: '/diagnostics', headers: { cookie: c } })).body).toContain('Name lookup');
  });

  it('refuse a diagnostics run posted from another site', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/diagnostics/run',
      headers: { ...FORM, cookie: await cookie(), origin: 'https://evil.example' },
      payload: '',
    });
    expect(res.statusCode).toBe(403);
    expect(fakeChecks).not.toHaveBeenCalled();
  });

  it('show the machine, the network and whether the page is encrypted', async () => {
    const res = await get('/diagnostics');
    expect(res.body).toContain('This machine');
    expect(res.body).toContain('http://10.0.0.5:8080');
    expect(res.body).toContain('Not encrypted');
    expect(res.body).toContain('Download support bundle');
  });

  it('show the log newest first, filter by level and escape what it shows', async () => {
    const all = await get('/logs');
    expect(all.body.indexOf('not json at all')).toBeLessThan(all.body.indexOf('Enrolled with the cloud'));
    expect(all.body).not.toContain('<b>x</b>');
    expect(all.body).toContain('&lt;b&gt;x&lt;/b&gt;');
    const warn = await get('/logs?level=warn');
    expect(warn.body).toContain('Something broke');
    expect(warn.body).not.toContain('Enrolled with the cloud');
    const errors = await get('/logs?level=error');
    expect(errors.body).toContain('Something broke');
    expect(errors.body).not.toContain('Cloud sync failed');
  });

  it('give a support bundle with status, devices and log, and never the admin code', async () => {
    const res = await get('/support-bundle');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('kestrel-gateway-support-');
    const body = JSON.parse(res.body) as { status: { name: string }; devices: { name: string }[]; log: { message: string }[]; generatedBy: string };
    expect(body.status.name).toBe('Level 2 gateway');
    expect(body.devices.map((d) => d.name)).toContain('Projector');
    expect(body.log.some((l) => l.message === 'Something broke')).toBe(true);
    expect(res.body).not.toContain(CODE);
    expect(gateway.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'local.action', data: expect.objectContaining({ action: 'support-bundle' }) }),
    );
  });
});

describe('the checks themselves', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kg-checks-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const lookupOk = (async () => ({ address: '203.0.113.9', family: 4 })) as never;

  it('pass when everything is fine', async () => {
    const now = Date.parse('2026-10-07T10:00:00Z');
    const results = await runChecks({
      cloudUrl: 'https://kestrel.example',
      dataDir: dir,
      lookupImpl: lookupOk,
      fetchImpl: (async () =>
        new Response(null, { status: 200, headers: { date: new Date(now + 2000).toUTCString() } })) as never,
      now: () => now,
    });
    const by = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(by.dns?.status).toBe('ok');
    expect(by.https?.status).toBe('ok');
    expect(by.clock?.status).toBe('ok');
    expect(by.write?.status).toBe('ok');
  });

  it('say what failed, in plain words', async () => {
    const results = await runChecks({
      cloudUrl: 'https://kestrel.example',
      dataDir: dir,
      lookupImpl: (async () => {
        throw new Error('getaddrinfo ENOTFOUND kestrel.example');
      }) as never,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed', { cause: new Error('connect ETIMEDOUT') });
      }) as never,
    });
    const by = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(by.dns?.status).toBe('fail');
    expect(by.dns?.detail).toContain('DNS');
    expect(by.https?.status).toBe('fail');
    expect(by.https?.detail).toContain('ETIMEDOUT');
    expect(by.https?.detail).toContain('443');
  });

  it('warn about a clock that is far out, in either direction', async () => {
    const now = Date.parse('2026-10-07T10:00:00Z');
    for (const offset of [5 * 60_000, -5 * 60_000]) {
      const results = await runChecks({
        cloudUrl: 'https://kestrel.example',
        dataDir: dir,
        lookupImpl: lookupOk,
        fetchImpl: (async () =>
          new Response(null, { status: 404, headers: { date: new Date(now + offset).toUTCString() } })) as never,
        now: () => now,
      });
      const clock = results.find((r) => r.id === 'clock');
      expect(clock?.status).toBe('warn');
      expect(clock?.detail).toContain(offset > 0 ? 'behind' : 'ahead');
    }
  });

  it('report a data folder that cannot be written to', async () => {
    const results = await runChecks({
      cloudUrl: 'https://kestrel.example',
      dataDir: join(dir, 'does', 'not', 'exist'),
      lookupImpl: lookupOk,
      fetchImpl: (async () => new Response(null, { status: 200 })) as never,
    });
    expect(results.find((r) => r.id === 'write')?.status).toBe('fail');
  });

  it('report facts about the machine and tail a log', () => {
    const facts = hostFacts(dir);
    expect(facts.node).toBe(process.version);
    expect(facts.memoryTotalMb).toBeGreaterThan(0);
    expect(tailLog(join(dir, 'missing.log'), 10)).toEqual([]);
  });
});
