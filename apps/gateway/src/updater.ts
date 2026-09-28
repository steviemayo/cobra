import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BundleLocation, GatewayUpdateOrder, GatewayUpdateReport } from '@kestrel/model';
import type { GatewayConfig } from './config';
import { compareVersions, releasePublicKey, verifyBundleSignature } from './release-signature';

// Carrying out an update the portal ordered. The portal decides when; the gateway does the work,
// and only after it has checked the bundle against the digest in the order. How it is done depends
// on how it is installed:
//   windows     the Windows service or tray app: download the bundle, check it, stage it, and start
//               the "Kestrel Gateway Update" scheduled task, which runs update.ps1 outside this
//               process (it has to stop and replace it) and puts the old version back if the new
//               one does not come up
//   watchtower  a container started from docker-compose.yml: ask Watchtower to update it
//   none        anything else: say so, rather than pretend

export class UpdateError extends Error {
  constructor(
    message: string,
    /** This install cannot do it at all (as opposed to failing this time). */
    readonly unsupported = false,
  ) {
    super(message);
  }
}

export interface UpdateIo {
  /** Where the bundle to install is described. Called with the gateway's own credential. */
  bundle: () => Promise<BundleLocation>;
  progress: (report: GatewayUpdateReport) => void;
}

export interface Updater {
  readonly kind: 'windows' | 'watchtower' | 'none';
  apply(order: GatewayUpdateOrder, io: UpdateIo): Promise<void>;
}

export interface UpdateDeps {
  fetchImpl?: typeof fetch;
  /** Runs a program and resolves when it has been started and exited. Tests replace it. */
  run?: (file: string, args: string[]) => Promise<void>;
  platform?: NodeJS.Platform;
  execPath?: string;
  /** The key bundles must be signed with. Defaults to the one built into the gateway. */
  releaseKey?: string;
  /** The cloud's address: the one place besides GitHub a bundle may be fetched from. */
  cloudOrigin?: string;
  /** The version running now: an order for this one or an older one is refused. */
  currentVersion?: string;
}

const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
export const UPDATE_TASK = 'Kestrel Gateway Update';

const defaultRun = (file: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 30_000 }, (err, _out, stderr) =>
      err ? reject(new Error(stderr?.toString().trim() || err.message)) : resolve(),
    );
  });

/** Where the Windows install lives, from the node.exe this process runs on: <root>\app\runtime\node.exe. */
export function windowsLayout(execPath: string) {
  const root = dirname(dirname(dirname(execPath)));
  return {
    root,
    installed: join(root, 'update.ps1'),
    bundled: join(root, 'app', 'windows', 'update.ps1'),
    settings: join(root, 'gateway.env'),
  };
}

export type WindowsLayout = ReturnType<typeof windowsLayout>;

/** Where a bundle may be fetched from: GitHub's release storage, or the cloud this gateway already talks to. */
export function bundleHostAllowed(rawUrl: string, cloudOrigin?: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (cloudOrigin && url.origin === new URL(cloudOrigin).origin) return true;
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'github.com' || host === 'githubusercontent.com' || host.endsWith('.githubusercontent.com');
}

/** The folder where an update is staged and where update.ps1 leaves its verdict. */
export const updateDir = (dataDir: string) => join(dataDir, 'update');

export class WindowsUpdater implements Updater {
  readonly kind = 'windows' as const;

  constructor(
    private readonly dataDir: string,
    private readonly layout: WindowsLayout,
    private readonly deps: UpdateDeps = {},
  ) {}

  async apply(order: GatewayUpdateOrder, io: UpdateIo): Promise<void> {
    if (!order.bundle)
      throw new UpdateError('The portal sent no digest for the bundle, so it was not installed.');
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const run = this.deps.run ?? defaultRun;
    io.progress({ state: 'downloading', version: order.version });

    const location = await io.bundle();
    if (location.sha256 !== order.bundle.sha256 || location.version !== order.version)
      throw new UpdateError('The bundle on offer is not the version that was ordered.');
    // Code that runs as the system: it must be signed by Kestrel's release key (which the portal
    // does not hold), come from a place Kestrel publishes to, and be newer than what is running.
    if (!location.signature)
      throw new UpdateError('The release is not signed by Kestrel, so it was not installed.');
    if (!bundleHostAllowed(location.url, this.deps.cloudOrigin))
      throw new UpdateError('The bundle is offered from a place Kestrel does not publish to.');
    if (this.deps.currentVersion) {
      const order2 = compareVersions(order.version, this.deps.currentVersion);
      if (order2 === null || order2 <= 0)
        throw new UpdateError(`Version ${order.version} is not newer than ${this.deps.currentVersion}.`);
    }
    const releaseKey = this.deps.releaseKey ?? releasePublicKey();

    const dir = updateDir(this.dataDir);
    mkdirSync(dir, { recursive: true });
    const zip = join(dir, 'bundle.zip');
    const part = `${zip}.part`;
    rmSync(part, { force: true });
    try {
      // The link is already signed by the release host: no credential goes with it.
      const res = await fetchImpl(location.url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok || !res.body) throw new UpdateError(`The download failed (HTTP ${res.status}).`);
      const hash = createHash('sha256');
      await pipeline(
        Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(part),
      );
      const actual = hash.digest('hex');
      if (actual !== order.bundle.sha256)
        throw new UpdateError('The download does not match its digest, so it was thrown away.');
      // The check that matters: the signature is over the file just downloaded, not over a digest the portal gave.
      if (!verifyBundleSignature(releaseKey, order.version, actual, location.signature))
        throw new UpdateError('The download is not signed by Kestrel, so it was thrown away.');
      renameSync(part, zip);
    } catch (e) {
      rmSync(part, { force: true });
      throw e;
    }

    // update.ps1 checks the signature again with the installed gateway's own key before it swaps anything.
    writeFileSync(`${zip}.sig`, location.signature);
    writeFileSync(
      join(dir, 'request.json'),
      JSON.stringify({ version: order.version, sha256: order.bundle.sha256, zip }),
    );
    // The installed script may be older than this gateway: use the one that came with this bundle.
    if (existsSync(this.layout.bundled)) copyFileSync(this.layout.bundled, this.layout.installed);
    io.progress({ state: 'staged', version: order.version });

    // The task runs as SYSTEM outside this process, which it is about to stop and replace.
    await run('schtasks', ['/Run', '/TN', UPDATE_TASK]).catch((e: unknown) => {
      throw new UpdateError(
        `Could not start the update task: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
    io.progress({ state: 'applying', version: order.version });
  }
}

export class WatchtowerUpdater implements Updater {
  readonly kind = 'watchtower' as const;

  constructor(
    private readonly url: string,
    private readonly token: string | undefined,
    private readonly deps: UpdateDeps = {},
  ) {}

  async apply(order: GatewayUpdateOrder, io: UpdateIo): Promise<void> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    io.progress({ state: 'applying', version: order.version });
    // Watchtower pulls the image for the channel this container follows and replaces it.
    const res = await fetchImpl(this.url, {
      method: 'POST',
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
      signal: AbortSignal.timeout(60_000),
    }).catch((e: unknown) => {
      throw new UpdateError(
        `Could not reach the updater: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
    if (!res.ok) throw new UpdateError(`The updater refused the request (HTTP ${res.status}).`);
  }
}

export class NoUpdater implements Updater {
  readonly kind = 'none' as const;
  constructor(private readonly reason: string) {}
  async apply(): Promise<void> {
    throw new UpdateError(this.reason, true);
  }
}

/** The way this install can update itself, or one that says why it cannot. */
export function createUpdater(
  cfg: Pick<GatewayConfig, 'dataDir' | 'updateUrl' | 'updateToken'> &
    Partial<Pick<GatewayConfig, 'cloudUrl' | 'version'>>,
  deps: UpdateDeps = {},
): Updater {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    const layout = windowsLayout(deps.execPath ?? process.execPath);
    return existsSync(layout.installed) && existsSync(layout.settings)
      ? new WindowsUpdater(cfg.dataDir, layout, {
          cloudOrigin: cfg.cloudUrl,
          currentVersion: cfg.version,
          ...deps,
        })
      : new NoUpdater('This is not an installed Windows gateway, so it cannot update itself.');
  }
  if (cfg.updateUrl) return new WatchtowerUpdater(cfg.updateUrl, cfg.updateToken, deps);
  return new NoUpdater(
    'This install cannot update itself. Use the docker-compose setup, which includes an updater.',
  );
}

/** What update.ps1 left after its last run: a report to send if it had to put the old version back. */
export function takeUpdateResult(dataDir: string): GatewayUpdateReport | undefined {
  const file = join(updateDir(dataDir), 'result.json');
  if (!existsSync(file)) return undefined;
  let result: { version?: unknown; ok?: unknown; error?: unknown } = {};
  try {
    result = JSON.parse(readFileSync(file, 'utf8')) as typeof result;
  } catch {
    // unreadable: nothing worth reporting
  }
  rmSync(file, { force: true });
  if (result.ok !== false) return undefined;
  return {
    state: 'failed',
    ...(typeof result.version === 'string' ? { version: result.version.slice(0, 50) } : {}),
    error: (typeof result.error === 'string' && result.error
      ? result.error
      : 'The new version did not start, so the old one was put back.'
    ).slice(0, 300),
  };
}
