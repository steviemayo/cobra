import { randomBytes } from 'node:crypto';
import { hostname, networkInterfaces, platform, release as osRelease } from 'node:os';
import { ANY_KEY_ID, verifyBindings, verifyManifest } from '@kestrel/crypto';
import {
  GATEWAY_FEATURES,
  PROTOCOL_VERSION,
  PublicKey,
  type AssignedRoom,
  type CommandResult,
  type ConfigResponse,
  type DeploymentReport,
  type DeploymentStage,
  type EnrollResponse,
  type GatewayUpdateOrder,
  type GatewayUpdateReport,
  type GatewayCommand,
  type RoomReport,
  type SignedManifest,
  type TelemetryEvent,
} from '@kestrel/model';
import { CloudClient, CloudError } from './cloud';
import type { GatewayConfig } from './config';
import { PhoneLinks } from './phone';
import { createUpdater, takeUpdateResult, UpdateError, type Updater } from './updater';
import { ScheduleStore } from './schedule';
import { GroupCoordinator } from './groups';
import { runCommand } from './commands';
import type { Logger } from './log';
import type { RoomBindings, RoomHost } from './room-host';
import type { Store } from './store';

const KEY_CREDENTIAL = 'credential';
const KEY_IDENTITY = 'identity';
const KEY_PUBLIC_KEYS = 'publicKeys';
const KEY_CONFIG_VERSION = 'configVersion';
const KEY_CONTROL = 'control';
const KEY_INSTALL = 'install';
const BINDINGS_PREFIX = 'bindings:';
const keyBindings = (roomId: string) => `${BINDINGS_PREFIX}${roomId}`;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 15_000;
const MAX_PARALLEL_DEPLOYS = 8;
const DEPLOYMENT_PREFIX = 'deployment:';
const keyDeployment = (roomId: string) => `${DEPLOYMENT_PREFIX}${roomId}`;
const isRefused = (stage: DeploymentStage) => stage === 'failed' || stage === 'rolled_back';

interface DeploymentRecord {
  deploymentId: string;
  releaseId: string;
  stage: DeploymentStage;
  history: { stage: DeploymentStage; at: string }[];
  error?: string;
}

type DeployOutcome = 'applied' | 'refused' | 'retry';

/** An update is not started again for the same version this soon: an attempt that has reached the installer is left to finish. */
const UPDATE_RETRY_MS = 20 * 60_000;
const UPDATE_REPORT_MS = 10 * 60_000;

/** This gateway cannot enrol yet and has said so: nothing is wrong, it is waiting for staff to claim it. */
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
  control: boolean;
  bufferedEvents: number;
  update: { state: string; version?: string; error?: string } | null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

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
 * The gateway's control loop. It enrols once, then on a fixed heartbeat reports what is running,
 * pulls new room releases when the cloud says config changed, and replays buffered telemetry.
 * Rooms never wait on any of this: cached releases boot straight from local storage.
 */
export class Gateway {
  private readonly startedAt = Date.now();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private stopped = false;
  /** Problems with the latest attempt to load a release, reported per room. */
  private readonly roomErrors = new Map<string, string>();
  /** Commands the cloud has handed over but that have not run yet. */
  private readonly inbox: GatewayCommand[] = [];
  /** Outcomes still to be reported in the next heartbeat. */
  private readonly pendingResults: CommandResult[] = [];
  /** Rooms someone is controlling from the portal; while there are any, the cloud is polled fast. */
  private watch = new Set<string>();
  private fastTimer: ReturnType<typeof setTimeout> | null = null;
  /** One poll was asked for although nobody is watching (a webhook is waiting). */
  private pollOnce = false;

  constructor(
    private readonly cfg: GatewayConfig,
    private readonly store: Store,
    private readonly cloud: CloudClient,
    private readonly host: RoomHost,
    private readonly log: Logger,
    private readonly updater: Updater = createUpdater(cfg),
  ) {
    // What the plan said last time, so a restart while offline does not start accepting commands.
    host.setControl(store.get(KEY_CONTROL) !== 'off');
    this.groups = new GroupCoordinator(host, store, log);
    this.phone = new PhoneLinks(store, cfg.cloudUrl);
  }

  /** Signs the QR links shown on room panels. */
  readonly phone: PhoneLinks;
  /** Today's bookings for each room, as the cloud last sent them. */
  readonly bookings = new ScheduleStore();
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

  private readonly groups: GroupCoordinator;

  // ---- Lifecycle ------------------------------------------------------------------------------

  /** Start rooms from the local cache immediately, then begin talking to the cloud. */
  start() {
    this.bootFromCache();
    // If the installer had to put the old version back, say so once the cloud is reachable.
    this.updateReport = takeUpdateResult(this.cfg.dataDir);
    this.record({ type: 'gateway.started', data: { version: this.cfg.version } });
    void this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.fastTimer) clearTimeout(this.fastTimer);
  }

  get identity(): Identity | null {
    return this.store.getJson<Identity>(KEY_IDENTITY);
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
      control: this.host.control,
      bufferedEvents: this.store.unsentCount(),
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
  enrolWithToken(token: string): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
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

  /** Forget the organisation and start again as an unclaimed gateway. Rooms stop running. */
  reset(): Promise<void> {
    return this.exclusive(() => {
      this.forgetOrganisation();
      // A new install id, so staff see a fresh unclaimed gateway rather than a claim that was already used.
      this.store.delete(KEY_INSTALL);
      this.claimedToken = null;
      this.configTokenRefused = true;
      this.announcedStatus = null;
      this.announceHoldUntil = 0;
      this.log('warn', 'Reset from the local admin page: forgot the organisation, will announce as unclaimed');
    });
  }

  /** Everything that belongs to the organisation this gateway was in: rooms, releases, addresses, credential. */
  private forgetOrganisation() {
    for (const id of new Set([...this.host.ids(), ...this.deploymentRoomIds()])) this.host.unload(id);
    for (const { roomId } of this.store.loadManifests()) this.store.deleteManifest(roomId);
    for (const prefix of [BINDINGS_PREFIX, DEPLOYMENT_PREFIX, 'phone:'])
      for (const key of this.store.keysWithPrefix(prefix)) this.store.delete(key);
    for (const key of [
      KEY_CREDENTIAL,
      KEY_IDENTITY,
      KEY_PUBLIC_KEYS,
      KEY_CONFIG_VERSION,
      KEY_CONTROL,
    ])
      this.store.delete(key);
    this.groups.setConfig([]);
    // Events the old organisation never received must not be filed under the new one.
    this.store.clearTelemetry();
    this.roomErrors.clear();
    this.inbox.length = 0;
    this.pendingResults.length = 0;
    this.updateReport = undefined;
    this.watch = new Set();
    this.host.setControl(true);
    this.lastContactAt = null;
  }

  record(event: Omit<TelemetryEvent, 'at'> & { at?: string }) {
    this.store.enqueue({ at: new Date().toISOString(), ...event, data: event.data ?? {} });
  }

  // ---- Offline boot ---------------------------------------------------------------------------

  /**
   * The keys a release or a set of bindings must be signed with. A gateway with keys built in
   * (every real one) trusts those and nothing the cloud sends, unless told to: keys that came from
   * the same server that hands out releases would protect nothing against that server.
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
      .filter((k) => !builtIn.some((b) => b.keyId === k.keyId && b.publicKeyPem.trim() === k.publicKeyPem.trim()))
      .map((k) => k.keyId)
      .sort()
      .join(',');
    if (!unknown || unknown === this.untrustedKeysSeen) return;
    this.untrustedKeysSeen = unknown;
    this.log('warn', 'The cloud offered signing keys this gateway does not trust and will not use', {
      keys: unknown,
      hint: 'A gateway update that includes them is needed before releases signed with them can run',
    });
  }
  private untrustedKeysSeen = '';

  private bootFromCache() {
    const keys = this.trustedKeys();
    for (const cached of this.store.loadManifests()) {
      // Re-verify on every boot: the local file is not trusted just because we wrote it.
      const result = verifyManifest(cached.raw, keys);
      if (!result.ok) {
        this.log('warn', 'Cached release failed verification and was not started', {
          roomId: cached.roomId,
          reason: result.reason,
        });
        this.roomErrors.set(cached.roomId, `Cached release rejected (${result.reason})`);
        continue;
      }
      let bindings: RoomBindings | undefined;
      if (result.signed.manifest.bindingsExternal || this.store.get(keyBindings(cached.roomId))) {
        const found = this.cachedBindings(cached.roomId, result.signed.manifest.orgId, keys);
        if (found) bindings = found;
        else if (result.signed.manifest.bindingsExternal) {
          this.log('warn', 'Cached bindings missing or failed verification; room not started', {
            roomId: cached.roomId,
          });
          this.roomErrors.set(
            cached.roomId,
            'Saved addresses and logins are missing or were rejected',
          );
          continue;
        }
      }
      try {
        this.host.load(result.signed, bindings);
      } catch (e) {
        this.log('error', 'Could not start cached room', {
          roomId: cached.roomId,
          error: String(e),
        });
      }
    }
  }

  /** Bindings saved by an earlier run, checked again like a cached manifest. */
  private cachedBindings(roomId: string, orgId: string, keys: PublicKey[]): RoomBindings | null {
    const raw = this.store.getJson<unknown>(keyBindings(roomId));
    if (!raw) return null;
    const result = verifyBindings(raw, keys);
    if (
      !result.ok ||
      result.signed.payload.roomId !== roomId ||
      result.signed.payload.orgId !== orgId
    )
      return null;
    return {
      version: result.signed.payload.version,
      devices: result.signed.payload.devices as RoomBindings['devices'],
      ...(result.signed.payload.sharedDevices
        ? { sharedDevices: result.signed.payload.sharedDevices }
        : {}),
    };
  }

  /**
   * Download and check a room's addresses and logins. Anything short of the version the cloud
   * asked for, or for a different room or organisation, is refused. Network trouble is a retry.
   */
  private async fetchBindings(
    credential: string,
    assigned: AssignedRoom,
    keys: PublicKey[],
  ): Promise<
    | { ok: true; bindings: RoomBindings; raw: unknown }
    | { ok: false; retry: boolean; problem: string }
  > {
    let raw: unknown;
    try {
      raw = await this.cloud.bindings(credential, assigned.roomId);
    } catch (e) {
      const missing = e instanceof CloudError && e.status === 404;
      this.log('warn', 'Could not download a room’s bindings', {
        roomId: assigned.roomId,
        error: String(e),
      });
      return {
        ok: false,
        retry: !missing,
        problem: missing
          ? 'the cloud has no addresses for this room'
          : 'could not download addresses',
      };
    }
    const result = verifyBindings(raw, keys);
    if (!result.ok)
      return {
        ok: false,
        retry: false,
        problem: `addresses failed the signature check (${result.reason})`,
      };
    const { payload } = result.signed;
    if (payload.roomId !== assigned.roomId || payload.orgId !== this.identity?.orgId)
      return { ok: false, retry: false, problem: 'addresses are for a different room' };
    if (assigned.bindingsVersion && payload.version < assigned.bindingsVersion)
      return { ok: false, retry: true, problem: 'addresses are older than the cloud asked for' };
    return {
      ok: true,
      raw,
      bindings: {
        version: payload.version,
        devices: payload.devices as RoomBindings['devices'],
        ...(payload.sharedDevices ? { sharedDevices: payload.sharedDevices } : {}),
      },
    };
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

  private async runTick(): Promise<void> {
    const used = this.store.get(KEY_CREDENTIAL);
    try {
      await this.ensureEnrolled();
      await this.heartbeat();
      await this.flushTelemetry();
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
      // Back off, but never stop trying, and never touch running rooms.
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
    // Support is waiting on these, so they go before any slow release work.
    await this.processCommands(credential);
    if (res.configVersion !== this.store.get(KEY_CONFIG_VERSION)) {
      const progressed = await this.syncConfig(credential);
      // Tell the cloud how the deployment went now rather than a heartbeat later.
      if (progressed) await this.sendHeartbeat(credential);
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
        rooms: this.roomReports(),
        commandResults: results,
        dividers: this.groups.report(),
        features: [...GATEWAY_FEATURES],
        ...(this.updateReport ? { updateReport: this.updateReport } : {}),
      })
      .catch((e: unknown) => {
        if (e instanceof CloudError && e.unauthorised)
          this.log('error', 'The cloud rejected this gateway’s credential');
        throw e;
      });
    this.pendingResults.splice(0, results.length);
    // A failure only needs telling once; progress is repeated until it settles.
    if (this.updateReport?.state === 'failed' || this.updateReport?.state === 'unsupported')
      this.updateReport = undefined;
    if (res.updateOrder) this.startUpdate(credential, res.updateOrder);
    this.inbox.push(...res.commands);
    if (res.control !== this.host.control) this.store.set(KEY_CONTROL, res.control ? 'on' : 'off');
    this.host.setControl(res.control);
    this.setWatch(res.watch);
    this.bookings.apply(res.schedules);
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
    // A webhook is waiting: collect it now instead of waiting for someone to open a control page.
    if (res.pollNow && !this.stopped) {
      this.pollOnce = true;
      if (!this.fastTimer) this.scheduleFast(0);
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

  // ---- Control from the portal ----------------------------------------------------------------

  private setWatch(rooms: string[]) {
    this.watch = new Set(rooms);
    if (this.watch.size > 0 && !this.fastTimer && !this.stopped) this.scheduleFast(0);
  }

  private scheduleFast(ms: number) {
    // One timer at a time: a heartbeat can ask for a poll while one is in flight, and an orphaned
    // timer is one stop() can never clear.
    if (this.fastTimer) clearTimeout(this.fastTimer);
    this.fastTimer = setTimeout(() => void this.fastTick(), ms);
  }

  /** One round trip: send the watched rooms' panel state up, run the intents that come back. */
  private async fastTick(): Promise<void> {
    this.fastTimer = null;
    // Stopped first: the store may already be closed.
    if (this.stopped) return;
    const credential = this.store.get(KEY_CREDENTIAL);
    if (!credential || (this.watch.size === 0 && !this.pollOnce)) return;
    this.pollOnce = false;
    let next = 1000;
    try {
      const panels = [...this.watch].flatMap((roomId) => {
        // While walls are open, a member room shows (and is controlled through) the combined room.
        const room = this.host.active(roomId);
        return room ? [{ roomId, vm: room.runtime.getSnapshot() }] : [];
      });
      const res = await this.cloud.poll(credential, { protocol: PROTOCOL_VERSION, panels });
      this.watch = new Set(res.watch);
      for (const { roomId, intent } of res.intents) {
        const runtime = this.host.active(roomId)?.runtime;
        if (!runtime) continue;
        if (intent.type === 'divider.set') void this.groups.set(intent.dividerId, intent.open);
        else if (intent.type === 'trigger') {
          const ran = runtime.fireTrigger(intent.triggerId);
          this.log('info', 'Trigger requested', { roomId, trigger: intent.triggerId, ran });
        } else if (intent.type === 'hook') {
          const ran = runtime.fireHook(intent.hookName);
          this.log('info', 'Webhook received', { roomId, hook: intent.hookName, triggers: ran });
        } else runtime.dispatch(intent);
      }
      // Something just changed, so report it back quickly.
      if (res.intents.length > 0) next = 250;
    } catch (e) {
      if (e instanceof CloudError && e.unauthorised) this.forgetCredential(credential);
      this.log('warn', 'Portal control poll failed', {
        error: e instanceof Error ? e.message : String(e),
      });
      next = 3000;
    }
    if (this.watch.size > 0 && !this.stopped) this.scheduleFast(next);
  }

  /** Run what the cloud asked for, then report straight away rather than a heartbeat later. */
  private async processCommands(credential: string): Promise<void> {
    for (let round = 0; round < 3 && this.inbox.length > 0; round++) {
      for (const cmd of this.inbox.splice(0)) {
        let result: CommandResult;
        try {
          result = await runCommand(this.host, cmd, {
            version: this.cfg.version,
            uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
            bufferedEvents: this.store.unsentCount(),
          });
        } catch (e) {
          result = {
            id: cmd.id,
            ok: false,
            output: {},
            error: e instanceof Error ? e.message.slice(0, 300) : 'Command failed',
          };
        }
        this.log('info', 'Ran a remote command', {
          type: cmd.type,
          roomId: cmd.roomId,
          ok: result.ok,
        });
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

  private deploymentRoomIds(): string[] {
    return this.store
      .keysWithPrefix(DEPLOYMENT_PREFIX)
      .map((k) => k.slice(DEPLOYMENT_PREFIX.length));
  }

  private roomReports(): RoomReport[] {
    const reports = this.host.reports();
    // Rooms with no running release still get reported, so the portal can show why.
    const known = new Set(reports.map((r) => r.roomId));
    for (const roomId of new Set([...this.roomErrors.keys(), ...this.deploymentRoomIds()]))
      if (!known.has(roomId))
        reports.push({ roomId, releaseId: null, status: 'unloaded', devices: [] });
    return reports.map((r) => {
      const error = this.roomErrors.get(r.roomId);
      const deployment = this.deploymentReport(r.roomId);
      return { ...r, ...(error ? { error } : {}), ...(deployment ? { deployment } : {}) };
    });
  }

  private deploymentRecord(roomId: string): DeploymentRecord | null {
    return this.store.getJson<DeploymentRecord>(keyDeployment(roomId));
  }

  private deploymentReport(roomId: string): DeploymentReport | undefined {
    const rec = this.deploymentRecord(roomId);
    if (!rec) return undefined;
    return {
      deploymentId: rec.deploymentId,
      stage: rec.stage,
      history: rec.history.slice(-20),
      ...(rec.error ? { error: rec.error } : {}),
    };
  }

  private mark(roomId: string, rec: DeploymentRecord, stage: DeploymentStage, error?: string) {
    rec.stage = stage;
    // A download retried every heartbeat is still one "downloading" step.
    if (rec.history.at(-1)?.stage !== stage)
      rec.history.push({ stage, at: new Date().toISOString() });
    if (rec.history.length > 20) rec.history.splice(0, rec.history.length - 20);
    if (error) rec.error = error;
    this.store.setJson(keyDeployment(roomId), rec);
  }

  // ---- Config sync ----------------------------------------------------------------------------

  /** Returns true if any room's deployment moved on, so the cloud should hear about it. */
  private async syncConfig(credential: string): Promise<boolean> {
    const config: ConfigResponse = await this.cloud.config(credential);
    if (config.publicKeys.length) this.store.setJson(KEY_PUBLIC_KEYS, config.publicKeys);
    this.noteUntrustedCloudKeys(config.publicKeys);
    this.groups.setConfig(config.groups);
    this.phone.setSecrets(config.rooms);
    const keys = this.trustedKeys();
    const wanted = new Map(config.rooms.map((r) => [r.roomId, r]));
    let progressed = false;

    for (const id of new Set([...this.host.ids(), ...this.deploymentRoomIds()]))
      if (!wanted.has(id)) {
        this.host.unload(id);
        this.store.deleteManifest(id);
        this.store.delete(keyBindings(id));
        this.store.delete(keyDeployment(id));
        this.roomErrors.delete(id);
        progressed = true;
      }

    const todo: AssignedRoom[] = [];
    const rebind: AssignedRoom[] = [];
    for (const assigned of config.rooms) {
      const rec = this.deploymentRecord(assigned.roomId);
      if (this.host.releaseOf(assigned.roomId) === assigned.releaseId) {
        this.roomErrors.delete(assigned.roomId);
        if (
          assigned.bindingsVersion &&
          this.host.get(assigned.roomId)?.bindings?.version !== assigned.bindingsVersion
        )
          rebind.push(assigned);
        if (rec?.deploymentId !== assigned.deploymentId) {
          // Already running (from the cache, or set up before deployments existed): that is this deployment's result.
          this.store.setJson(keyDeployment(assigned.roomId), {
            deploymentId: assigned.deploymentId,
            releaseId: assigned.releaseId,
            stage: 'active',
            history: [{ stage: 'active', at: new Date().toISOString() }],
          } satisfies DeploymentRecord);
          progressed = true;
        }
        continue;
      }
      // A refused deployment stays refused; only a new deployment earns another attempt.
      if (rec?.deploymentId === assigned.deploymentId && isRefused(rec.stage)) continue;
      todo.push(assigned);
    }

    let allApplied = true;
    for (let i = 0; i < todo.length; i += MAX_PARALLEL_DEPLOYS) {
      const outcomes = await Promise.all(
        todo.slice(i, i + MAX_PARALLEL_DEPLOYS).map((a) => this.deploy(credential, a, keys)),
      );
      for (const outcome of outcomes) {
        if (outcome === 'retry') allApplied = false;
        else progressed = true;
      }
    }
    // An address or login changed with no new release: restart the room on the new values.
    for (const assigned of rebind) {
      const outcome = await this.rebind(credential, assigned, keys);
      if (outcome === 'retry') allApplied = false;
      else progressed = true;
    }
    // Only remember this config version once every room is settled, so failed downloads get retried.
    if (allApplied) this.store.set(KEY_CONFIG_VERSION, config.configVersion);
    return progressed;
  }

  /**
   * Move one room to its assigned release without ever leaving it broken: download, check the
   * signature, build the new room alongside the running one, wait for its devices to answer, and
   * only then swap. If any step fails the running release is untouched.
   */
  private async deploy(
    credential: string,
    assigned: AssignedRoom,
    keys: PublicKey[],
  ): Promise<DeployOutcome> {
    const { roomId } = assigned;
    const existing = this.deploymentRecord(roomId);
    const rec: DeploymentRecord =
      existing && existing.deploymentId === assigned.deploymentId && !isRefused(existing.stage)
        ? existing
        : {
            deploymentId: assigned.deploymentId,
            releaseId: assigned.releaseId,
            stage: 'downloading',
            history: [],
          };
    this.mark(roomId, rec, 'downloading');

    let raw: unknown;
    try {
      raw = await this.cloud.manifest(credential, roomId, assigned.releaseId);
    } catch (e) {
      // Network trouble: keep whatever is running and try again next heartbeat.
      this.log('warn', 'Could not download a release', { roomId, error: String(e) });
      return 'retry';
    }

    this.mark(roomId, rec, 'verifying');
    const result = verifyManifest(raw, keys);
    const m = result.ok ? result.signed.manifest : null;
    const problem = !result.ok
      ? `signature check failed (${result.reason})`
      : result.signed.hash !== assigned.manifestHash
        ? 'hash does not match what was assigned'
        : m!.roomId !== roomId || m!.releaseId !== assigned.releaseId
          ? 'manifest is for a different room or release'
          : null;
    if (problem || !result.ok) return this.refuse(rec, assigned, problem ?? 'unknown');

    // Addresses and logins travel apart from the release when it says so, or when the room has them.
    let bindings: { bindings: RoomBindings; raw: unknown } | undefined;
    if (m!.bindingsExternal || assigned.bindingsVersion) {
      const got = await this.fetchBindings(credential, assigned, keys);
      if (!got.ok) return got.retry ? 'retry' : this.refuse(rec, assigned, got.problem);
      bindings = got;
    }

    this.mark(roomId, rec, 'staging');
    let staged;
    try {
      staged = this.host.stage(result.signed, bindings?.bindings);
    } catch (e) {
      return this.refuse(
        rec,
        assigned,
        `could not start the room (${e instanceof Error ? e.message : String(e)})`,
      );
    }

    this.mark(roomId, rec, 'health_check');
    let unreachable: string[];
    try {
      unreachable = await this.host.healthCheck(
        staged,
        this.cfg.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
      );
    } catch (e) {
      staged.close();
      return this.refuse(
        rec,
        assigned,
        `health check failed (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    // A device not answering yet is a monitoring problem, not a reason to refuse the whole release:
    // it deploys anyway and the usual device_offline incident picks it up once heartbeats resume.
    if (unreachable.length > 0)
      this.log('warn', `Deploying with ${unreachable.length} device(s) not answering`, {
        roomId,
        devices: unreachable,
      });

    this.host.activate(staged);
    this.store.saveManifest(result.signed);
    if (bindings) this.store.setJson(keyBindings(roomId), bindings.raw);
    else this.store.delete(keyBindings(roomId));
    this.roomErrors.delete(roomId);
    delete rec.error;
    this.mark(roomId, rec, 'active');
    return 'applied';
  }

  /**
   * Run the release a room already has with new addresses or logins, the same careful way as a
   * deployment: build alongside, wait for the devices to answer, then swap. On any failure the
   * room keeps running with what it had.
   */
  private async rebind(
    credential: string,
    assigned: AssignedRoom,
    keys: PublicKey[],
  ): Promise<DeployOutcome> {
    const { roomId } = assigned;
    const running = this.host.get(roomId);
    if (!running) return 'refused';
    const got = await this.fetchBindings(credential, assigned, keys);
    const fail = (problem: string): DeployOutcome => {
      const message = `New addresses rejected: ${problem}`;
      this.log('error', message, { roomId });
      this.roomErrors.set(roomId, message);
      return 'refused';
    };
    if (!got.ok) return got.retry ? 'retry' : fail(got.problem);
    let staged;
    try {
      staged = this.host.stage(running.signed, got.bindings);
    } catch (e) {
      return fail(`could not start the room (${e instanceof Error ? e.message : String(e)})`);
    }
    let unreachable: string[];
    try {
      unreachable = await this.host.healthCheck(
        staged,
        this.cfg.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
      );
    } catch (e) {
      staged.close();
      return fail(`health check failed (${e instanceof Error ? e.message : String(e)})`);
    }
    if (unreachable.length > 0)
      this.log('warn', `Rebinding with ${unreachable.length} device(s) not answering`, {
        roomId,
        devices: unreachable,
      });
    this.host.activate(staged);
    this.store.setJson(keyBindings(roomId), got.raw);
    this.roomErrors.delete(roomId);
    this.log('info', 'Room restarted on new addresses', { roomId, version: got.bindings.version });
    return 'applied';
  }

  private refuse(rec: DeploymentRecord, assigned: AssignedRoom, problem: string): DeployOutcome {
    const keptRunning = this.host.releaseOf(assigned.roomId) !== null;
    const message = `Release ${assigned.releaseNumber} rejected: ${problem}`;
    this.mark(assigned.roomId, rec, keptRunning ? 'rolled_back' : 'failed', message);
    this.reject(assigned, problem);
    return 'refused';
  }

  private reject(assigned: AssignedRoom, problem: string) {
    const message = `Release ${assigned.releaseNumber} rejected: ${problem}`;
    this.log('error', message, { roomId: assigned.roomId });
    this.roomErrors.set(assigned.roomId, message);
    this.record({
      type: 'manifest.rejected',
      roomId: assigned.roomId,
      data: { releaseId: assigned.releaseId, problem },
    });
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

export type { SignedManifest };
