import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair } from '@kestrel/crypto';
import type { GatewayUpdateOrder, GatewayUpdateReport } from '@kestrel/model';
import { CloudClient } from './cloud';
import type { GatewayConfig } from './config';
import { Gateway } from './gateway';
import { silentLogger } from './log';
import { signBundle } from './release-signature';
import { RoomHost } from './room-host';
import { Store } from './store';
import { FakeCloud, ENROLL_TOKEN } from './test-support/fake-cloud';
import {
  NoUpdater,
  UPDATE_TASK,
  UpdateError,
  WatchtowerUpdater,
  WindowsUpdater,
  createUpdater,
  takeUpdateResult,
  updateDir,
  windowsLayout,
  bundleHostAllowed,
  type Updater,
  type UpdateDeps,
  type UpdateIo,
} from './updater';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await wait(15);
  }
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let dir: string;
let cloud: FakeCloud;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kestrel-upd-'));
  cloud = await new FakeCloud().start();
});
afterEach(async () => {
  await cloud.stop();
  rmSync(dir, { recursive: true, force: true });
});

const BYTES = Buffer.from('pretend this is a zip of the new gateway');
const VERSION = '9.9.9';
// The release key: CI holds the private half, the gateway ships the public half.
const releaseKeys = generateKeyPair();
const signed = (version = VERSION, bytes = BYTES) =>
  signBundle(releaseKeys.privateKeyPem, version, sha(bytes));
/** What a WindowsUpdater needs beyond how to run programs: the trusted key and the cloud's address. */
const trust = (over: Partial<UpdateDeps> = {}): UpdateDeps => ({
  releaseKey: releaseKeys.publicKeyPem,
  cloudOrigin: cloud.url,
  currentVersion: '0.2.7',
  ...over,
});

/** A Windows install laid out on disk: <root>\\app\\runtime\\node.exe, update.ps1, gateway.env. */
function install(root: string, opts: { bundledScript?: boolean } = {}) {
  mkdirSync(join(root, 'app', 'runtime'), { recursive: true });
  mkdirSync(join(root, 'app', 'windows'), { recursive: true });
  writeFileSync(join(root, 'update.ps1'), 'OLD SCRIPT');
  writeFileSync(join(root, 'gateway.env'), 'KESTREL_CHANNEL=stable');
  if (opts.bundledScript !== false)
    writeFileSync(join(root, 'app', 'windows', 'update.ps1'), 'NEW SCRIPT');
  return windowsLayout(join(root, 'app', 'runtime', 'node.exe'));
}

function io(bundle: () => Promise<Awaited<ReturnType<UpdateIo['bundle']>>>) {
  const seen: GatewayUpdateReport['state'][] = [];
  return {
    seen,
    io: {
      bundle,
      progress: (r: GatewayUpdateReport) => void seen.push(r.state),
    } satisfies UpdateIo,
  };
}

const location =
  (over: Partial<{ sha256: string; version: string; signature: string | null; url: string }> = {}) =>
  async () => ({
    url: over.url ?? `${cloud.url}/asset/bundle.zip`,
    sha256: over.sha256 ?? sha(BYTES),
    version: over.version ?? VERSION,
    ...(over.signature === null ? {} : { signature: over.signature ?? signed() }),
  });

describe('updating a Windows gateway', () => {
  const order = (over: Partial<GatewayUpdateOrder> = {}): GatewayUpdateOrder => ({
    version: VERSION,
    bundle: { sha256: sha(BYTES) },
    ...over,
  });

  it('downloads the bundle, checks it, stages it, refreshes the installed script and starts the task', async () => {
    cloud.bundle = { bytes: BYTES, version: VERSION };
    const layout = install(join(dir, 'install'));
    const runs: string[][] = [];
    const u = new WindowsUpdater(dir, layout, trust({ run: async (f, a) => void runs.push([f, ...a]) }));
    const p = io(location());
    await u.apply(order(), p.io);

    expect(p.seen).toEqual(['downloading', 'staged', 'applying']);
    const staged = join(updateDir(dir), 'bundle.zip');
    expect(readFileSync(staged)).toEqual(BYTES);
    expect(JSON.parse(readFileSync(join(updateDir(dir), 'request.json'), 'utf8'))).toEqual({
      version: VERSION,
      sha256: sha(BYTES),
      zip: staged,
    });
    expect(readFileSync(layout.installed, 'utf8')).toBe('NEW SCRIPT');
    expect(runs).toEqual([['schtasks', '/Run', '/TN', UPDATE_TASK]]);
  });

  it('throws away a download that does not match its digest, and starts nothing', async () => {
    cloud.bundle = { bytes: Buffer.from('something else entirely'), version: VERSION };
    const layout = install(join(dir, 'install'));
    const runs: string[][] = [];
    const u = new WindowsUpdater(dir, layout, trust({ run: async (f, a) => void runs.push([f, ...a]) }));
    // The portal's order and its bundle link agree on a digest that the served bytes do not match.
    const p = io(location({ sha256: sha(BYTES) }));
    await expect(u.apply(order(), p.io)).rejects.toThrow('does not match its digest');
    expect(existsSync(join(updateDir(dir), 'bundle.zip'))).toBe(false);
    expect(existsSync(join(updateDir(dir), 'bundle.zip.part'))).toBe(false);
    expect(existsSync(join(updateDir(dir), 'request.json'))).toBe(false);
    expect(readFileSync(layout.installed, 'utf8')).toBe('OLD SCRIPT');
    expect(runs).toEqual([]);
  });

  it('refuses an order that has no digest, without downloading anything', async () => {
    cloud.bundle = { bytes: BYTES, version: VERSION };
    const layout = install(join(dir, 'install'));
    let asked = 0;
    const u = new WindowsUpdater(dir, layout, trust({ run: async () => undefined }));
    await expect(
      u.apply({ version: VERSION }, io(async () => (asked++, location()())).io),
    ).rejects.toThrow('no digest');
    expect(asked).toBe(0);
  });

  it('refuses a bundle that is not the version or digest that was ordered', async () => {
    cloud.bundle = { bytes: BYTES, version: VERSION };
    const layout = install(join(dir, 'install'));
    const u = new WindowsUpdater(dir, layout, trust({ run: async () => undefined }));
    await expect(u.apply(order(), io(location({ version: '1.0.0' })).io)).rejects.toThrow(
      'not the version',
    );
    await expect(u.apply(order(), io(location({ sha256: 'b'.repeat(64) })).io)).rejects.toThrow(
      'not the version',
    );
  });

  it('says the task could not be started, and leaves the stage in place for a retry', async () => {
    cloud.bundle = { bytes: BYTES, version: VERSION };
    const layout = install(join(dir, 'install'));
    const u = new WindowsUpdater(
      dir,
      layout,
      trust({
        run: async () => {
          throw new Error('Access is denied');
        },
      }),
    );
    await expect(u.apply(order(), io(location()).io)).rejects.toThrow(
      'Could not start the update task: Access is denied',
    );
  });

  // ---- What the portal cannot do: make the gateway install code Kestrel did not sign -----------

  describe('code that Kestrel did not sign', () => {
    const attempt = async (loc: ReturnType<typeof location>, deps: Partial<UpdateDeps> = {}) => {
      cloud.bundle = { bytes: BYTES, version: VERSION };
      const layout = install(join(dir, 'install'));
      const runs: string[][] = [];
      const u = new WindowsUpdater(
        dir,
        layout,
        trust({ run: async (f, a) => void runs.push([f, ...a]), ...deps }),
      );
      const result = await u.apply(order(), io(loc).io).then(
        () => 'installed',
        (e: Error) => e.message,
      );
      return { result, runs, layout };
    };
    const nothingStaged = (r: Awaited<ReturnType<typeof attempt>>) => {
      expect(r.runs).toEqual([]);
      expect(existsSync(join(updateDir(dir), 'bundle.zip'))).toBe(false);
      expect(existsSync(join(updateDir(dir), 'request.json'))).toBe(false);
      expect(readFileSync(r.layout.installed, 'utf8')).toBe('OLD SCRIPT');
    };

    it('refuses a release that carries no signature', async () => {
      const r = await attempt(location({ signature: null }));
      expect(r.result).toContain('not signed by Kestrel');
      nothingStaged(r);
    });

    it('refuses a signature made with some other key', async () => {
      const other = generateKeyPair();
      const r = await attempt(location({ signature: signBundle(other.privateKeyPem, VERSION, sha(BYTES)) }));
      expect(r.result).toContain('not signed by Kestrel');
      nothingStaged(r);
    });

    it('refuses bytes that are not the ones the signature covers, even when the portal digest matches them', async () => {
      // The portal names a digest for what it serves; only the signature ties it to Kestrel.
      const forged = Buffer.from('code the portal made up');
      cloud.bundle = { bytes: forged, version: VERSION };
      const layout = install(join(dir, 'install'));
      const runs: string[][] = [];
      const u = new WindowsUpdater(dir, layout, trust({ run: async (f, a) => void runs.push([f, ...a]) }));
      const result = await u
        .apply(
          { version: VERSION, bundle: { sha256: sha(forged) } },
          io(location({ sha256: sha(forged), signature: signed(VERSION, BYTES) })).io,
        )
        .then(
          () => 'installed',
          (e: Error) => e.message,
        );
      expect(result).toContain('not signed by Kestrel');
      expect(runs).toEqual([]);
      expect(existsSync(join(updateDir(dir), 'bundle.zip'))).toBe(false);
    });

    it('refuses a signed bundle passed off as a different version', async () => {
      const r = await attempt(location({ signature: signed('1.0.0') }));
      expect(r.result).toContain('not signed by Kestrel');
      nothingStaged(r);
    });

    it('refuses an order that is not newer than what is running', async () => {
      const same = await attempt(location(), { currentVersion: VERSION });
      expect(same.result).toContain('not newer');
      nothingStaged(same);
      const older = await attempt(location(), { currentVersion: '10.0.0' });
      expect(older.result).toContain('not newer');
    });

    it('refuses a bundle offered from somewhere Kestrel does not publish', async () => {
      const r = await attempt(location({ url: 'https://evil.example/bundle.zip' }));
      expect(r.result).toContain('does not publish');
      nothingStaged(r);
    });

    it('records the signature next to the staged bundle for update.ps1 to check again', async () => {
      const r = await attempt(location());
      expect(r.result).toBe('installed');
      expect(readFileSync(join(updateDir(dir), 'bundle.zip.sig'), 'utf8')).toBe(signed());
    });
  });

  it('only fetches bundles from GitHub storage or the cloud it already talks to', () => {
    const cloudOrigin = 'https://kestrel.example';
    for (const ok of [
      'https://github.com/o/r/releases/download/x/y.zip',
      'https://objects.githubusercontent.com/abc',
      'https://release-assets.githubusercontent.com/abc?sig=1',
      'https://kestrel.example/bundle.zip',
    ])
      expect(bundleHostAllowed(ok, cloudOrigin), ok).toBe(true);
    for (const bad of [
      'http://github.com/x',
      'https://github.com.evil.example/x',
      'https://evilgithubusercontent.com/x',
      'https://evil.example/x',
      'http://kestrel.example/x',
      'not a url',
    ])
      expect(bundleHostAllowed(bad, cloudOrigin), bad).toBe(false);
  });
});

describe('the other ways an install can (not) update', () => {
  let hook: Server;
  afterEach(() => hook?.close());

  it('asks Watchtower with its token, and reports a refusal', async () => {
    const calls: { method?: string; auth?: string; url?: string }[] = [];
    let status = 200;
    hook = createServer((req, res) => {
      calls.push({ method: req.method, auth: req.headers.authorization, url: req.url });
      res.writeHead(status);
      res.end();
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(hook.address() as { port: number }).port}/v1/update`;
    const u = new WatchtowerUpdater(url, 'secret-token');
    const p = io(location());
    await u.apply({ version: VERSION }, p.io);
    expect(p.seen).toEqual(['applying']);
    expect(calls).toEqual([{ method: 'POST', auth: 'Bearer secret-token', url: '/v1/update' }]);
    status = 401;
    await expect(u.apply({ version: VERSION }, p.io)).rejects.toThrow('HTTP 401');
  });

  it('a gateway with no updater says so instead of pretending', async () => {
    const u = new NoUpdater('cannot');
    await expect(u.apply()).rejects.toMatchObject({ unsupported: true });
  });

  it('picks the way from how it is installed', () => {
    const layout = install(join(dir, 'install'));
    const execPath = join(dir, 'install', 'app', 'runtime', 'node.exe');
    expect(layout.installed).toContain('update.ps1');
    expect(createUpdater({ dataDir: dir }, { platform: 'win32', execPath }).kind).toBe('windows');
    expect(
      createUpdater(
        { dataDir: dir },
        { platform: 'win32', execPath: join(dir, 'elsewhere', 'a', 'b', 'node.exe') },
      ).kind,
    ).toBe('none');
    expect(
      createUpdater(
        { dataDir: dir, updateUrl: 'http://127.0.0.1:1/v1/update' },
        { platform: 'linux' },
      ).kind,
    ).toBe('watchtower');
    expect(createUpdater({ dataDir: dir }, { platform: 'linux' }).kind).toBe('none');
  });

  it('reports a failed update from the installer once, then forgets it', () => {
    mkdirSync(updateDir(dir), { recursive: true });
    const file = join(updateDir(dir), 'result.json');
    writeFileSync(file, JSON.stringify({ ok: false, version: VERSION, error: 'did not start' }));
    expect(takeUpdateResult(dir)).toEqual({
      state: 'failed',
      version: VERSION,
      error: 'did not start',
    });
    expect(existsSync(file)).toBe(false);
    expect(takeUpdateResult(dir)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ ok: true }));
    expect(takeUpdateResult(dir)).toBeUndefined();
    writeFileSync(file, 'not json');
    expect(takeUpdateResult(dir)).toBeUndefined();
  });
});

// ---- The gateway reacting to an order ---------------------------------------------------------

function boot(updater: Updater, version = '0.0.1') {
  const cfg: GatewayConfig = {
    cloudUrl: cloud.url,
    enrollToken: ENROLL_TOKEN,
    dataDir: dir,
    panelPort: 0,
    panelHost: '127.0.0.1',
    panelDir: '',
    simulate: 'all',
    logLevel: 'error',
    version,
  };
  const store = new Store(join(dir, 'gateway.db'));
  const host = new RoomHost('all', silentLogger, (e) => store.enqueue(e));
  const gateway = new Gateway(cfg, store, new CloudClient(cloud.url), host, silentLogger, updater);
  return { gateway, host, store };
}

describe('a gateway told to update', () => {
  const stub = (result: 'ok' | 'fail' | 'unsupported') => {
    const applied: GatewayUpdateOrder[] = [];
    const updater: Updater = {
      kind: 'windows',
      async apply(order, i) {
        applied.push(order);
        i.progress({ state: 'staged', version: order.version });
        if (result === 'fail') throw new UpdateError('The download failed (HTTP 500).');
        if (result === 'unsupported') throw new UpdateError('cannot', true);
        i.progress({ state: 'applying', version: order.version });
      },
    };
    return { updater, applied };
  };
  const lastReport = () => cloud.heartbeats.at(-1)?.updateReport;

  it('advertises that it can, and acts on the order once', async () => {
    const { updater, applied } = stub('ok');
    const { gateway, host, store } = boot(updater);
    cloud.updateOrder = { version: VERSION, bundle: { sha256: 'a'.repeat(64) } };
    await gateway.tick();
    await until(() => applied.length === 1);
    expect(cloud.heartbeats[0]!.features).toContain('self-update');
    // Still ordered in the next heartbeat (the portal repeats it), but a running attempt is not repeated.
    await gateway.tick();
    await gateway.tick();
    expect(applied).toHaveLength(1);
    // Progress is reported back.
    await until(() => lastReport()?.state === 'applying');
    expect(lastReport()).toMatchObject({ state: 'applying', version: VERSION });
    gateway.stop();
    host.shutdown();
    store.close();
  });

  it('reports a failure once, and does not try the same version again straight away', async () => {
    const { updater, applied } = stub('fail');
    const { gateway, host, store } = boot(updater);
    cloud.updateOrder = { version: VERSION, bundle: { sha256: 'a'.repeat(64) } };
    await gateway.tick();
    await until(() => applied.length === 1);
    await wait(20);
    await gateway.tick();
    expect(lastReport()).toMatchObject({
      state: 'failed',
      error: 'The download failed (HTTP 500).',
    });
    await gateway.tick();
    expect(lastReport()).toBeUndefined();
    expect(applied).toHaveLength(1);
    gateway.stop();
    host.shutdown();
    store.close();
  });

  it('says an install that cannot update itself is unsupported', async () => {
    const { updater } = stub('unsupported');
    const { gateway, host, store } = boot(updater);
    cloud.updateOrder = { version: VERSION };
    await gateway.tick();
    await wait(30);
    await gateway.tick();
    expect(lastReport()).toMatchObject({ state: 'unsupported' });
    gateway.stop();
    host.shutdown();
    store.close();
  });

  it('ignores an order for the version it already runs', async () => {
    const { updater, applied } = stub('ok');
    const { gateway, host, store } = boot(updater, VERSION);
    cloud.updateOrder = { version: VERSION };
    await gateway.tick();
    await wait(30);
    expect(applied).toHaveLength(0);
    gateway.stop();
    host.shutdown();
    store.close();
  });

  it('tells the portal when the installer had to put the old version back', async () => {
    mkdirSync(updateDir(dir), { recursive: true });
    writeFileSync(
      join(updateDir(dir), 'result.json'),
      JSON.stringify({ ok: false, version: VERSION, error: 'did not start' }),
    );
    const { gateway, host, store } = boot(stub('ok').updater);
    gateway.start();
    await until(() => cloud.heartbeats.length > 0);
    expect(cloud.heartbeats[0]!.updateReport).toEqual({
      state: 'failed',
      version: VERSION,
      error: 'did not start',
    });
    gateway.stop();
    host.shutdown();
    store.close();
  });
});
