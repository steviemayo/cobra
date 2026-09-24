import { hostname, platform, release as osRelease } from 'node:os';
import { ANY_KEY_ID, verifyManifest } from '@kestrel/crypto';
import {
  PROTOCOL_VERSION,
  PublicKey,
  type AssignedRoom,
  type CommandResult,
  type ConfigResponse,
  type DeploymentReport,
  type DeploymentStage,
  type EnrollResponse,
  type GatewayCommand,
  type RoomReport,
  type SignedManifest,
  type TelemetryEvent,
} from '@kestrel/model';
import { CloudClient, CloudError } from './cloud';
import type { GatewayConfig } from './config';
import { PhoneLinks } from './phone';
import { CombineCoordinator } from './combine';
import { runCommand } from './commands';
import type { Logger } from './log';
import type { RoomHost } from './room-host';
import type { Store } from './store';

const KEY_CREDENTIAL = 'credential';
const KEY_IDENTITY = 'identity';
const KEY_PUBLIC_KEYS = 'publicKeys';
const KEY_CONFIG_VERSION = 'configVersion';
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
  ) {
    this.combine = new CombineCoordinator(host, store, log);
    this.phone = new PhoneLinks(store, cfg.cloudUrl);
  }

  /** Signs the QR links shown on room panels. */
  readonly phone: PhoneLinks;
  private announcedUpdate: string | null = null;

  private readonly combine: CombineCoordinator;

  // ---- Lifecycle ------------------------------------------------------------------------------

  /** Start rooms from the local cache immediately, then begin talking to the cloud. */
  start() {
    this.bootFromCache();
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

  record(event: Omit<TelemetryEvent, 'at'> & { at?: string }) {
    this.store.enqueue({ at: new Date().toISOString(), ...event, data: event.data ?? {} });
  }

  // ---- Offline boot ---------------------------------------------------------------------------

  private trustedKeys(): PublicKey[] {
    const keys = this.store.getJson<PublicKey[]>(KEY_PUBLIC_KEYS) ?? [];
    if (this.cfg.pinnedPublicKey)
      keys.push({ keyId: ANY_KEY_ID, publicKeyPem: this.cfg.pinnedPublicKey });
    return keys;
  }

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
      try {
        this.host.load(result.signed);
      } catch (e) {
        this.log('error', 'Could not start cached room', {
          roomId: cached.roomId,
          error: String(e),
        });
      }
    }
  }

  // ---- Control loop ---------------------------------------------------------------------------

  private schedule(ms: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.ensureEnrolled();
      await this.heartbeat();
      await this.flushTelemetry();
      this.failures = 0;
      this.schedule((this.identity?.heartbeatSeconds ?? 30) * 1000);
    } catch (e) {
      this.failures++;
      const unreachable = e instanceof CloudError && e.unreachable;
      this.log(unreachable ? 'warn' : 'error', 'Cloud sync failed', {
        error: e instanceof Error ? e.message : String(e),
        attempt: this.failures,
      });
      // Back off, but never stop trying, and never touch running rooms.
      this.schedule(Math.min(MAX_BACKOFF_MS, 5000 * 2 ** Math.min(this.failures - 1, 4)));
    }
  }

  private async ensureEnrolled(): Promise<void> {
    if (this.store.get(KEY_CREDENTIAL)) return;
    if (!this.cfg.enrollToken)
      throw new CloudError('Not enrolled and no KESTREL_ENROLL_TOKEN set', 401);
    const res: EnrollResponse = await this.cloud.enroll({
      protocol: PROTOCOL_VERSION,
      token: this.cfg.enrollToken,
      hostname: hostname(),
      gatewayVersion: this.cfg.version,
      os: `${platform()} ${osRelease()}`,
    });
    this.store.set(KEY_CREDENTIAL, res.credential);
    this.store.setJson(KEY_PUBLIC_KEYS, res.publicKeys);
    this.store.setJson(KEY_IDENTITY, {
      gatewayId: res.gatewayId,
      orgId: res.orgId,
      name: res.name,
      heartbeatSeconds: res.heartbeatSeconds,
    } satisfies Identity);
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
    const results = this.pendingResults.slice(0, 50);
    const res = await this.cloud
      .heartbeat(credential, {
        protocol: PROTOCOL_VERSION,
        gatewayVersion: this.cfg.version,
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
        configVersion: this.store.get(KEY_CONFIG_VERSION),
        rooms: this.roomReports(),
        commandResults: results,
        combinations: this.combine.report(),
      })
      .catch((e: unknown) => {
        if (e instanceof CloudError && e.unauthorised)
          this.log('error', 'The cloud rejected this gateway’s credential');
        throw e;
      });
    this.pendingResults.splice(0, results.length);
    this.inbox.push(...res.commands);
    this.setWatch(res.watch);
    const { update } = res;
    if (update?.latest && update.latest !== this.cfg.version && update.latest !== this.announcedUpdate) {
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

  // ---- Control from the portal ----------------------------------------------------------------

  private setWatch(rooms: string[]) {
    this.watch = new Set(rooms);
    if (this.watch.size > 0 && !this.fastTimer && !this.stopped) this.scheduleFast(0);
  }

  private scheduleFast(ms: number) {
    this.fastTimer = setTimeout(() => void this.fastTick(), ms);
  }

  /** One round trip: send the watched rooms' panel state up, run the intents that come back. */
  private async fastTick(): Promise<void> {
    this.fastTimer = null;
    const credential = this.store.get(KEY_CREDENTIAL);
    if (this.stopped || !credential || (this.watch.size === 0 && !this.pollOnce)) return;
    this.pollOnce = false;
    let next = 1000;
    try {
      const panels = [...this.watch].flatMap((roomId) => {
        const room = this.host.get(roomId);
        return room ? [{ roomId, vm: room.runtime.getSnapshot() }] : [];
      });
      const res = await this.cloud.poll(credential, { protocol: PROTOCOL_VERSION, panels });
      this.watch = new Set(res.watch);
      for (const { roomId, intent } of res.intents) {
        const runtime = this.host.get(roomId)?.runtime;
        if (!runtime) continue;
        if (intent.type === 'combination.set')
          this.combine.set(intent.combinationId, intent.combined);
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
          result = runCommand(this.host, cmd, {
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
    this.combine.setConfig(config.combinations);
    this.phone.setSecrets(config.rooms);
    const keys = this.trustedKeys();
    const wanted = new Map(config.rooms.map((r) => [r.roomId, r]));
    let progressed = false;

    for (const id of new Set([...this.host.ids(), ...this.deploymentRoomIds()]))
      if (!wanted.has(id)) {
        this.host.unload(id);
        this.store.deleteManifest(id);
        this.store.delete(keyDeployment(id));
        this.roomErrors.delete(id);
        progressed = true;
      }

    const todo: AssignedRoom[] = [];
    for (const assigned of config.rooms) {
      const rec = this.deploymentRecord(assigned.roomId);
      if (this.host.releaseOf(assigned.roomId) === assigned.releaseId) {
        this.roomErrors.delete(assigned.roomId);
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

    this.mark(roomId, rec, 'staging');
    let staged;
    try {
      staged = this.host.stage(result.signed);
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
    if (unreachable.length > 0) {
      staged.close();
      return this.refuse(rec, assigned, `could not reach ${unreachable.join(', ')}`);
    }

    this.host.activate(staged);
    this.store.saveManifest(result.signed);
    this.roomErrors.delete(roomId);
    delete rec.error;
    this.mark(roomId, rec, 'active');
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
