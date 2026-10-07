import { randomBytes } from 'node:crypto';
import { hostname, networkInterfaces, platform, release as osRelease } from 'node:os';
import { ANY_KEY_ID, verifyDeviceSet } from '@kestrel/crypto';
import { DeviceHost, SETTLE_MS } from './device-host';
import {
  PROTOCOL_VERSION,
  PublicKey,
  type CommandResult,
  type DeviceReport,
  type EnrollResponse,
  type GatewayCommand,
  type GatewayUpdateOrder,
  type GatewayUpdateReport,
  type LocalAccessPolicy,
  type TelemetryEvent,
} from '@kestrel/model';
import { CloudClient, CloudError } from './cloud';
import type { GatewayConfig } from './config';
import type { LocalAccessContext } from './local-access';
import { createUpdater, takeUpdateResult, UpdateError, type Updater } from './updater';
import { runCommand } from './commands';
import type { Logger } from './log';
import type { Store } from './store';

const KEY_CREDENTIAL = 'credential';
const KEY_IDENTITY = 'identity';
const KEY_PUBLIC_KEYS = 'publicKeys';
const KEY_CONFIG_VERSION = 'configVersion';
const KEY_DEVICE_SET = 'deviceSet';
const KEY_INSTALL = 'install';
const KEY_LOCAL_ACCESS = 'localAccess';
const MAX_BACKOFF_MS = 60_000;
/** A confirmed device change waits this long for others to join it, then checks in. */
const URGENT_COALESCE_MS = 1_500;
/** Check-ins started by device changes are at least this far apart. */
const URGENT_MIN_GAP_MS = 3_000;

/** What this gateway can do, sent in every heartbeat so the portal only hands it work it can run. */
const FEATURES = ['discovery', 'firmware', 'self-update', 'device-set', 'config-enforce', 'address-tracking', 'browse-points', 'snapshot', 'local-signin'];

/** An update is not started again for the same version this soon: an attempt that has reached the installer is left to finish. */
const UPDATE_RETRY_MS = 20 * 60_000;
const UPDATE_REPORT_MS = 10 * 60_000;

/** The machine's own private IPv4 addresses, to help tell where an unclaimed gateway is. */
function localAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address)
    .slice(0, 8);
}

/** What the local status page shows about this gateway. */
export interface LocalStatus {
  version: string;
  cloudHost: string;
  installId: string | null;
  enrolment: 'enrolled' | 'unclaimed' | 'dismissed' | 'claimed' | 'refused' | 'connecting';
  name: string | null;
  lastContactAt: string | null;
  problem: string | null;
  bufferedEvents: number;
  /** How many devices this gateway is polling. */
  devices: number;
  update: { state: string; version?: string; error?: string } | null;
}

export interface CheckIn {
  at: string;
  ok: boolean;
  /** How long the whole check-in took. */
  ms: number;
  error?: string;
}

export interface GatewaySnapshot {
  startedAt: string;
  uptimeSeconds: number;
  gatewayId: string | null;
  heartbeatSeconds: number | null;
  checkIns: CheckIn[];
  consecutiveFailures: number;
  clockSkewMs: number | null;
  configVersion: string | null;
  deviceSetVersion: string | null;
  localUrls: string[];
  tls: boolean;
  trustedKeys: number;
  devices: DeviceReport[];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** This gateway cannot enrol yet and has said so: nothing is wrong, it is waiting for staff to claim it. */
class WaitingToBeClaimed extends Error {
  constructor(
    readonly status: 'unclaimed' | 'dismissed' | 'claimed',
    readonly retrySeconds: number,
  ) {
    super(`Waiting to be claimed (${status})`);
  }
}

interface Identity {
  gatewayId: string;
  orgId: string;
  name: string;
  heartbeatSeconds: number;
}

/**
 * The gateway's control loop. It enrols once, then on a fixed heartbeat reports what its devices are
 * doing, pulls a new device list when the cloud says it changed, puts back settings the cloud asks
 * for, and replays buffered telemetry. Devices never wait on any of this: the last verified device
 * list starts straight from local storage.
 */
export class Gateway {
  private readonly startedAt = Date.now();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private stopped = false;
  /** Commands the cloud has handed over but that have not run yet. */
  private readonly inbox: GatewayCommand[] = [];
  /** Outcomes still to be reported in the next heartbeat. */
  private readonly pendingResults: CommandResult[] = [];

  constructor(
    private readonly cfg: GatewayConfig,
    private readonly store: Store,
    private readonly cloud: CloudClient,
    private readonly log: Logger,
    private readonly updater: Updater = createUpdater(cfg),
    /** The devices polled, apart from any room (docs/pivot-monitoring.md). */
    readonly devices: DeviceHost = new DeviceHost(log),
  ) {}

  private announcedUpdate: string | null = null;
  /** How an update the portal ordered is going: sent in each heartbeat until it is settled. */
  private updateReport: GatewayUpdateReport | undefined;
  private updateReportSince = 0;
  private updating = false;
  /** An enrolment token staff handed over by claiming this gateway, and one from the settings that the cloud refused. */
  private claimedToken: string | null = null;
  private configTokenRefused = false;
  private announcedStatus: 'unclaimed' | 'dismissed' | 'claimed' | null = null;
  private announceHoldUntil = 0;
  private current: Promise<void> | null = null;
  /** While set, no cloud round trip starts: someone is changing who this gateway belongs to. */
  private hold = false;
  private lastContactAt: Date | null = null;
  private lastProblem: string | null = null;
  private lastUpdateAttempt: { version: string; at: number } | null = null;
  /** How the last check-ins went, newest last, for the page's troubleshooting view. */
  private readonly beats: CheckIn[] = [];
  /** How far this machine's clock is from Kestrel's at the last check-in (Kestrel minus here). */
  private skewMs: number | null = null;

  // ---- Lifecycle ------------------------------------------------------------------------------

  /** Start the saved devices immediately, then begin talking to the cloud. */
  start() {
    this.bootDevices(this.trustedKeys());
    this.devices.start();
    this.devices.onUrgent = () => this.pushSoon();
    // If the installer had to put the old version back, say so once the cloud is reachable.
    this.updateReport = takeUpdateResult(this.cfg.dataDir);
    this.record({ type: 'gateway.started', data: { version: this.cfg.version } });
    void this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.urgentTimer) clearTimeout(this.urgentTimer);
    this.urgentTimer = null;
  }

  private urgentTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUrgentAt = 0;

  /**
   * A device was confirmed down (or came back): check in now rather than at the next beat. Changes
   * a moment apart share one check-in, and check-ins this way are spaced out so a storm of them
   * can never hammer the cloud.
   */
  private pushSoon() {
    if (this.stopped || this.hold || this.urgentTimer || !this.store.get(KEY_CREDENTIAL)) return;
    const wait = Math.max(URGENT_COALESCE_MS, this.lastUrgentAt + URGENT_MIN_GAP_MS - Date.now());
    this.urgentTimer = setTimeout(() => {
      this.urgentTimer = null;
      this.lastUrgentAt = Date.now();
      this.wake();
    }, wait);
    this.urgentTimer.unref?.();
  }

  get identity(): Identity | null {
    return this.store.getJson<Identity>(KEY_IDENTITY);
  }

  private listener: { port: number; tls: boolean } | null = null;

  /** Where the local page ended up listening, so the portal can be told how people reach it. */
  setListener(port: number, tls: boolean) {
    this.listener = { port, tls };
  }

  /** The addresses people use to open this gateway's own page. The portal returns sign-ins only to these. */
  localUrls(): string[] {
    if (!this.listener) return [];
    const scheme = this.listener.tls ? 'https' : 'http';
    // This machine's own address too: the tray icon and the Start menu shortcut open the page that way.
    const names = new Set<string>(['127.0.0.1']);
    for (const list of Object.values(networkInterfaces()))
      for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) names.add(a.address);
    names.add(hostname().toLowerCase());
    for (const h of this.cfg.allowedHosts ?? []) if (h && !h.includes('*')) names.add(h);
    return [...names].slice(0, 20).map((n) => `${scheme}://${n}:${this.listener!.port}`);
  }

  /** Everything the troubleshooting pages show about how this gateway is getting on. Nothing secret. */
  snapshot(): GatewaySnapshot {
    const id = this.identity;
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      gatewayId: id?.gatewayId ?? null,
      heartbeatSeconds: id?.heartbeatSeconds ?? null,
      checkIns: [...this.beats].reverse(),
      consecutiveFailures: this.failures,
      clockSkewMs: this.skewMs,
      configVersion: this.store.get(KEY_CONFIG_VERSION),
      deviceSetVersion: this.devices.setVersion ?? null,
      localUrls: this.localUrls(),
      tls: this.listener?.tls ?? false,
      trustedKeys: this.trustedKeys().length,
      devices: this.devices.reports(),
    };
  }

  /** What the local page needs to decide who may sign in. Before the portal has said, the safe default: the admin code works. */
  localAccessContext(): LocalAccessContext {
    return {
      gatewayId: this.store.get(KEY_CREDENTIAL) ? (this.identity?.gatewayId ?? null) : null,
      keys: this.trustedKeys(),
      policy: this.store.getJson<LocalAccessPolicy>(KEY_LOCAL_ACCESS) ?? {
        breakGlass: true,
        epoch: 0,
      },
      cloudUrl: this.cfg.cloudUrl,
    };
  }

  /** What the local status page shows. Nothing secret: no credential, token or admin code. */
  status(): LocalStatus {
    const enrolled = !!this.store.get(KEY_CREDENTIAL);
    return {
      version: this.cfg.version,
      cloudHost: hostOf(this.cfg.cloudUrl),
      installId: this.store.getJson<{ id: string }>(KEY_INSTALL)?.id ?? null,
      enrolment: enrolled
        ? 'enrolled'
        : (this.announcedStatus ?? (this.configTokenRefused ? 'refused' : 'connecting')),
      name: this.identity?.name ?? null,
      lastContactAt: this.lastContactAt?.toISOString() ?? null,
      problem: this.lastProblem,
      bufferedEvents: this.store.unsentCount(),
      devices: this.devices.size,
      update: this.updateReport
        ? {
            state: this.updateReport.state,
            version: this.updateReport.version,
            ...(this.updateReport.error ? { error: this.updateReport.error } : {}),
          }
        : null,
    };
  }

  /**
   * Join an organisation with a token typed on this machine. The token is tried first, so a wrong
   * one changes nothing; a right one replaces whatever this gateway belonged to before.
   */
  enrolWithToken(
    token: string,
  ): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
    const clean = token.trim();
    if (!clean || clean.length > 300)
      return Promise.resolve({ ok: false, message: 'Enter the enrolment token from the portal.' });
    return this.exclusive(async () => {
      try {
        await this.enrollWith(clean);
        this.claimedToken = null;
        this.lastProblem = null;
        this.log('warn', 'Enrolled from the local admin page');
        return { ok: true as const, name: this.identity?.name ?? '' };
      } catch (e) {
        this.log('warn', 'A token typed on the local admin page did not work', {
          error: e instanceof Error ? e.message : String(e),
        });
        return {
          ok: false as const,
          message:
            e instanceof CloudError && e.unreachable
              ? 'The cloud cannot be reached from this machine, so the token could not be checked.'
              : e instanceof CloudError && e.unauthorised
                ? 'The portal did not accept that token. It may have been used already or have expired.'
                : 'The token could not be used. Check it and try again.',
        };
      }
    });
  }

  /** Forget the organisation and start again as an unclaimed gateway. Devices stop being polled. */
  reset(): Promise<void> {
    return this.exclusive(() => {
      this.forgetOrganisation();
      // A new install id, so staff see a fresh unclaimed gateway rather than a claim that was already used.
      this.store.delete(KEY_INSTALL);
      this.claimedToken = null;
      this.configTokenRefused = true;
      this.announcedStatus = null;
      this.announceHoldUntil = 0;
      this.log(
        'warn',
        'Reset from the local admin page: forgot the organisation, will announce as unclaimed',
      );
    });
  }

  /** Everything that belongs to the organisation this gateway was in: devices, credential, keys. */
  private forgetOrganisation() {
    this.devices.apply(null);
    for (const key of [
      KEY_CREDENTIAL,
      KEY_IDENTITY,
      KEY_PUBLIC_KEYS,
      KEY_CONFIG_VERSION,
      KEY_DEVICE_SET,
      KEY_LOCAL_ACCESS,
    ])
      this.store.delete(key);
    // Events the old organisation never received must not be filed under the new one.
    this.store.clearTelemetry();
    this.inbox.length = 0;
    this.pendingResults.length = 0;
    this.updateReport = undefined;
    this.lastContactAt = null;
  }

  record(event: Omit<TelemetryEvent, 'at'> & { at?: string }) {
    this.store.enqueue({ at: new Date().toISOString(), ...event, data: event.data ?? {} });
  }

  // ---- Offline boot ---------------------------------------------------------------------------

  /**
   * The keys a device set must be signed with. A gateway with keys built in (every real one) trusts
   * those and nothing the cloud sends, unless told to: keys that came from the same server that
   * hands out device lists would protect nothing against that server.
   */
  private trustedKeys(): PublicKey[] {
    const builtIn = this.cfg.trustedKeys ?? [];
    const fromCloud =
      builtIn.length === 0 || this.cfg.trustCloudKeys
        ? (this.store.getJson<PublicKey[]>(KEY_PUBLIC_KEYS) ?? [])
        : [];
    const keys = [...builtIn, ...fromCloud];
    if (this.cfg.pinnedPublicKey)
      keys.push({ keyId: ANY_KEY_ID, publicKeyPem: this.cfg.pinnedPublicKey });
    return keys;
  }

  /** Says so once when the cloud signs with a key this gateway does not trust: the usual sign of an unfinished rotation. */
  private noteUntrustedCloudKeys(offered: PublicKey[]) {
    const builtIn = this.cfg.trustedKeys ?? [];
    if (builtIn.length === 0 || this.cfg.trustCloudKeys) return;
    const unknown = offered
      .filter(
        (k) =>
          !builtIn.some(
            (b) => b.keyId === k.keyId && b.publicKeyPem.trim() === k.publicKeyPem.trim(),
          ),
      )
      .map((k) => k.keyId)
      .sort()
      .join(',');
    if (!unknown || unknown === this.untrustedKeysSeen) return;
    this.untrustedKeysSeen = unknown;
    this.log(
      'warn',
      'The cloud offered signing keys this gateway does not trust and will not use',
      {
        keys: unknown,
        hint: 'A gateway update that includes them is needed before device lists signed with them can run',
      },
    );
  }
  private untrustedKeysSeen = '';

  /** Restarts the polled devices from the last verified set, so they are watched with no internet. */
  private bootDevices(keys: PublicKey[]) {
    const raw = this.store.getJson<unknown>(KEY_DEVICE_SET);
    if (!raw) return;
    const result = verifyDeviceSet(raw, keys);
    if (!result.ok) {
      this.log('warn', 'The saved device list failed verification and was not started', {
        reason: result.reason,
      });
      return;
    }
    try {
      this.devices.apply(result.signed);
    } catch (e) {
      this.log('error', 'Could not start the saved devices', { error: String(e) });
    }
  }

  /** Fetches, verifies and applies the device set the cloud says this gateway should poll. */
  private async syncDeviceSet(credential: string): Promise<boolean> {
    let raw: unknown;
    try {
      raw = await this.cloud.deviceSet(credential);
    } catch (e) {
      this.log('warn', 'Could not download the device list', { error: String(e) });
      return false;
    }
    const result = verifyDeviceSet(raw, this.trustedKeys());
    if (!result.ok) {
      this.log('warn', 'The device list failed the signature check and was ignored', {
        reason: result.reason,
      });
      return false;
    }
    const { payload } = result.signed;
    if (payload.orgId !== this.identity?.orgId || payload.gatewayId !== this.identity?.gatewayId) {
      this.log('warn', 'The device list is for a different gateway and was ignored');
      return false;
    }
    this.devices.apply(result.signed);
    this.store.setJson(KEY_DEVICE_SET, raw);
    return true;
  }

  // ---- Control loop ---------------------------------------------------------------------------

  private schedule(ms: number) {
    if (this.stopped || this.hold) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  /** Check in with the cloud now instead of waiting for the next beat. */
  wake() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.tick();
  }

  /**
   * Runs a change to who this gateway belongs to with no cloud round trip in flight and none
   * started, so a late reply for the old credential cannot undo it.
   */
  private async exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    this.hold = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      await this.current?.catch(() => undefined);
      return await fn();
    } finally {
      this.hold = false;
      this.wake();
    }
  }

  tick(): Promise<void> {
    if (this.stopped || this.hold) return Promise.resolve();
    // One round trip at a time: a check-in asked for while one is in flight runs after it.
    const before = this.current;
    const next: Promise<void> = (async () => {
      await before;
      if (this.stopped || this.hold) return;
      await this.runTick();
    })().finally(() => {
      if (this.current === next) this.current = null;
    });
    this.current = next;
    return next;
  }

  private noteBeat(beat: CheckIn) {
    this.beats.push(beat);
    if (this.beats.length > 30) this.beats.shift();
  }

  private async runTick(): Promise<void> {
    const used = this.store.get(KEY_CREDENTIAL);
    const began = Date.now();
    try {
      await this.ensureEnrolled();
      await this.heartbeat();
      await this.flushTelemetry();
      this.noteBeat({ at: new Date().toISOString(), ok: true, ms: Date.now() - began });
      this.failures = 0;
      this.lastContactAt = new Date();
      this.lastProblem = null;
      this.schedule((this.identity?.heartbeatSeconds ?? 30) * 1000);
    } catch (e) {
      if (e instanceof WaitingToBeClaimed) {
        // Not a fault: say it once, then check again when the cloud asked us to.
        if (this.announcedStatus !== e.status) {
          this.announcedStatus = e.status;
          this.log(
            'info',
            'Not set up in any organisation yet: staff can claim this gateway in the portal',
            {
              status: e.status,
            },
          );
        }
        this.schedule(e.retrySeconds * 1000);
        return;
      }
      this.failures++;
      this.noteBeat({
        at: new Date().toISOString(),
        ok: false,
        ms: Date.now() - began,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      });
      const unreachable = e instanceof CloudError && e.unreachable;
      this.lastProblem = unreachable
        ? 'The cloud cannot be reached from this machine.'
        : e instanceof Error
          ? e.message.slice(0, 200)
          : 'The cloud sync failed.';
      if (e instanceof CloudError && e.unauthorised) this.forgetCredential(used);
      this.log(unreachable ? 'warn' : 'error', 'Cloud sync failed', {
        error: e instanceof Error ? e.message : String(e),
        attempt: this.failures,
      });
      // Back off, but never stop trying, and never touch running devices.
      this.schedule(Math.min(MAX_BACKOFF_MS, 5000 * 2 ** Math.min(this.failures - 1, 4)));
    }
  }

  /**
   * The cloud rejects this credential on every authenticated call and always will (it does a plain
   * lookup by credential hash - see `authenticateGateway` - so 401 here means the gateway's record
   * was deleted or its credential otherwise invalidated, not a transient blip). Forget it so the
   * next tick re-enrols from `KESTREL_ENROLL_TOKEN` instead of retrying a dead credential forever;
   * with no token configured, `ensureEnrolled` will raise that specific error instead.
   */
  private forgetCredential(rejected: string | null) {
    // Only the credential that was refused: a new one may have been saved while the call was out.
    const current = this.store.get(KEY_CREDENTIAL);
    if (!current || current !== rejected) return;
    this.store.delete(KEY_CREDENTIAL);
    this.store.delete(KEY_IDENTITY);
    this.store.delete(KEY_PUBLIC_KEYS);
    this.store.delete(KEY_CONFIG_VERSION);
    this.log('warn', 'Credential no longer valid; forgetting it and will try to re-enrol', {
      hasEnrollToken: !!this.cfg.enrollToken,
    });
  }

  private async ensureEnrolled(): Promise<void> {
    if (this.store.get(KEY_CREDENTIAL)) return;
    // The token from the settings, until the cloud refuses it; or one staff handed over by claiming this gateway.
    const token = this.claimedToken ?? (this.configTokenRefused ? undefined : this.cfg.enrollToken);
    if (token) {
      try {
        await this.enrollWith(token);
        this.claimedToken = null;
        return;
      } catch (e) {
        if (!(e instanceof CloudError && e.unauthorised)) throw e;
        // Used up, expired or never valid: fall back to announcing, so this does not go unseen.
        if (this.claimedToken) this.claimedToken = null;
        else this.configTokenRefused = true;
        this.log('warn', 'The enrolment token was refused; announcing this gateway instead');
      }
    }
    await this.announceSelf();
  }

  /** Says this gateway is here, and enrols with the token staff hand back once they have claimed it. */
  private async announceSelf(): Promise<void> {
    if (Date.now() < this.announceHoldUntil)
      throw new WaitingToBeClaimed(
        (this.announcedStatus as 'unclaimed' | 'dismissed' | 'claimed') ?? 'unclaimed',
        Math.ceil((this.announceHoldUntil - Date.now()) / 1000),
      );
    const install = this.installIdentity();
    const res = await this.cloud.announce({
      protocol: PROTOCOL_VERSION,
      installId: install.id,
      secret: install.secret,
      gatewayVersion: this.cfg.version,
      hostname: hostname(),
      os: `${platform()} ${osRelease()}`,
      localAddresses: localAddresses(),
    });
    this.announceHoldUntil = Date.now() + res.retrySeconds * 1000;
    if (res.status === 'claimed' && res.enrollToken) {
      this.claimedToken = res.enrollToken;
      this.announceHoldUntil = 0;
      return this.ensureEnrolled();
    }
    throw new WaitingToBeClaimed(res.status, res.retrySeconds);
  }

  /** Random and kept for the life of the install: the id is public, the secret proves it is the same install. */
  private installIdentity(): { id: string; secret: string } {
    const existing = this.store.getJson<{ id: string; secret: string }>(KEY_INSTALL);
    if (existing?.id && existing.secret) return existing;
    const made = {
      id: randomBytes(12).toString('base64url'),
      secret: randomBytes(24).toString('base64url'),
    };
    this.store.setJson(KEY_INSTALL, made);
    return made;
  }

  private async enrollWith(token: string): Promise<void> {
    const res: EnrollResponse = await this.cloud.enroll({
      protocol: PROTOCOL_VERSION,
      token,
      hostname: hostname(),
      gatewayVersion: this.cfg.version,
      os: `${platform()} ${osRelease()}`,
    });
    // Joining another organisation: nothing of the old one may keep running or be reported as the new one's.
    if (this.store.get(KEY_CREDENTIAL)) this.forgetOrganisation();
    this.store.set(KEY_CREDENTIAL, res.credential);
    this.store.setJson(KEY_PUBLIC_KEYS, res.publicKeys);
    this.store.setJson(KEY_IDENTITY, {
      gatewayId: res.gatewayId,
      orgId: res.orgId,
      name: res.name,
      heartbeatSeconds: res.heartbeatSeconds,
    } satisfies Identity);
    this.announcedStatus = null;
    this.log('info', 'Enrolled with the cloud', { gatewayId: res.gatewayId, name: res.name });
  }

  private async heartbeat(): Promise<void> {
    const credential = this.store.get(KEY_CREDENTIAL)!;
    const res = await this.sendHeartbeat(credential);
    // New devices to poll: start them, then report once they have had a moment to answer.
    const devicesChanged =
      !!res.deviceSetVersion &&
      res.deviceSetVersion !== this.devices.setVersion &&
      (await this.syncDeviceSet(credential));
    // Support is waiting on these, so they go before anything slow.
    await this.processCommands(credential);
    if (devicesChanged && !this.stopped) {
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      if (!this.stopped) await this.sendHeartbeat(credential);
    }
  }

  private async sendHeartbeat(credential: string) {
    // Progress that never turns into a new version stops being reported, so the portal can see it
    // has stalled instead of being told "applying" for ever.
    if (
      this.updateReport &&
      this.updateReport.state !== 'failed' &&
      this.updateReport.state !== 'unsupported' &&
      Date.now() - this.updateReportSince > UPDATE_REPORT_MS
    )
      this.updateReport = undefined;
    const results = this.pendingResults.slice(0, 50);
    const res = await this.cloud
      .heartbeat(credential, {
        protocol: PROTOCOL_VERSION,
        gatewayVersion: this.cfg.version,
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
        configVersion: this.store.get(KEY_CONFIG_VERSION),
        // Rooms are not run here any more; the field stays so a cloud that still asks for it can read this.
        rooms: [],
        devices: this.devices.reports(),
        ...(this.devices.setVersion ? { deviceSetVersion: this.devices.setVersion } : {}),
        commandResults: results,
        dividers: [],
        features: FEATURES,
        localUrls: this.localUrls(),
        ...(this.updateReport ? { updateReport: this.updateReport } : {}),
      })
      .catch((e: unknown) => {
        if (e instanceof CloudError && e.unauthorised)
          this.log('error', 'The cloud rejected this gateway’s credential');
        throw e;
      });
    this.pendingResults.splice(0, results.length);
    this.skewMs = Date.parse(res.serverTime) - Date.now();
    // Who may open the local page. Kept, so it still applies when the cloud cannot be reached.
    if (res.localAccess) this.store.setJson(KEY_LOCAL_ACCESS, res.localAccess);
    // A failure only needs telling once; progress is repeated until it settles.
    if (this.updateReport?.state === 'failed' || this.updateReport?.state === 'unsupported')
      this.updateReport = undefined;
    if (res.updateOrder) this.startUpdate(credential, res.updateOrder);
    // Settings the cloud wants put back on polled devices. Not awaited: the heartbeat must not wait on a slow device.
    for (const e of res.enforce) void this.devices.execute(e.deviceId, e.command);
    this.inbox.push(...res.commands);
    const { update } = res;
    if (
      update?.latest &&
      update.latest !== this.cfg.version &&
      update.latest !== this.announcedUpdate
    ) {
      this.announcedUpdate = update.latest;
      this.log('info', 'A different gateway version is published on this channel', {
        channel: update.channel,
        latest: update.latest,
        running: this.cfg.version,
      });
    }
    return res;
  }

  // ---- Updates the portal ordered -------------------------------------------------------------

  private startUpdate(credential: string, order: GatewayUpdateOrder) {
    if (this.updating || order.version === this.cfg.version) return;
    const last = this.lastUpdateAttempt;
    if (last && last.version === order.version && Date.now() - last.at < UPDATE_RETRY_MS) return;
    this.updating = true;
    this.lastUpdateAttempt = { version: order.version, at: Date.now() };
    this.log('info', 'The portal asked this gateway to update', {
      from: this.cfg.version,
      to: order.version,
      how: this.updater.kind,
    });
    void this.updater
      .apply(order, {
        bundle: () => this.cloud.bundle(credential),
        progress: (r) => {
          this.updateReport = r;
          this.updateReportSince = Date.now();
        },
      })
      .catch((e: unknown) => {
        const unsupported = e instanceof UpdateError && e.unsupported;
        const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        this.log('warn', 'The update did not go ahead', { error });
        this.updateReport = {
          state: unsupported ? 'unsupported' : 'failed',
          version: order.version,
          error,
        };
        this.updateReportSince = Date.now();
      })
      .finally(() => {
        this.updating = false;
      });
  }

  /** Run what the cloud asked for, then report straight away rather than a heartbeat later. */
  private async processCommands(credential: string): Promise<void> {
    for (let round = 0; round < 3 && this.inbox.length > 0; round++) {
      for (const cmd of this.inbox.splice(0)) {
        let result: CommandResult;
        try {
          result = await runCommand(cmd, this.devices);
        } catch (e) {
          result = {
            id: cmd.id,
            ok: false,
            output: {},
            error: e instanceof Error ? e.message.slice(0, 300) : 'Command failed',
          };
        }
        this.log('info', 'Ran a remote command', { type: cmd.type, ok: result.ok });
        this.record({
          type: 'command.finished',
          roomId: cmd.roomId,
          data: { type: cmd.type, ok: result.ok },
        });
        this.pendingResults.push(result);
      }
      await this.sendHeartbeat(credential);
    }
  }

  // ---- Telemetry ------------------------------------------------------------------------------

  private async flushTelemetry(): Promise<void> {
    const credential = this.store.get(KEY_CREDENTIAL)!;
    for (;;) {
      const batch = this.store.takeBatch(200);
      if (batch.length === 0) break;
      await this.cloud.telemetry(credential, {
        protocol: PROTOCOL_VERSION,
        events: batch.map((b) => b.event),
      });
      this.store.markSent(batch.map((b) => b.id));
    }
    this.store.pruneSent();
  }
}
