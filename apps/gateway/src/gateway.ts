import { hostname, platform, release as osRelease } from 'node:os';
import { ANY_KEY_ID, verifyManifest } from '@kestrel/crypto';
import {
  PROTOCOL_VERSION,
  PublicKey,
  type AssignedRoom,
  type ConfigResponse,
  type EnrollResponse,
  type SignedManifest,
  type TelemetryEvent,
} from '@kestrel/model';
import { CloudClient, CloudError } from './cloud';
import type { GatewayConfig } from './config';
import type { Logger } from './log';
import type { RoomHost } from './room-host';
import type { Store } from './store';

const KEY_CREDENTIAL = 'credential';
const KEY_IDENTITY = 'identity';
const KEY_PUBLIC_KEYS = 'publicKeys';
const KEY_CONFIG_VERSION = 'configVersion';
const MAX_BACKOFF_MS = 60_000;

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

  constructor(
    private readonly cfg: GatewayConfig,
    private readonly store: Store,
    private readonly cloud: CloudClient,
    private readonly host: RoomHost,
    private readonly log: Logger,
  ) {}

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
    if (this.cfg.pinnedPublicKey) keys.push({ keyId: ANY_KEY_ID, publicKeyPem: this.cfg.pinnedPublicKey });
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
        this.log('error', 'Could not start cached room', { roomId: cached.roomId, error: String(e) });
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
    const reports = this.host.reports();
    // Rooms that failed to load still get reported, so the portal can show why.
    for (const [roomId, error] of this.roomErrors)
      if (!reports.some((r) => r.roomId === roomId))
        reports.push({ roomId, releaseId: null, status: 'unloaded', error });
    const res = await this.cloud
      .heartbeat(credential, {
        protocol: PROTOCOL_VERSION,
        gatewayVersion: this.cfg.version,
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
        configVersion: this.store.get(KEY_CONFIG_VERSION),
        rooms: reports.map((r) => ({ ...r, ...(this.roomErrors.has(r.roomId) ? { error: this.roomErrors.get(r.roomId) } : {}) })),
      })
      .catch((e: unknown) => {
        if (e instanceof CloudError && e.unauthorised) this.log('error', 'The cloud rejected this gateway’s credential');
        throw e;
      });
    if (res.configVersion !== this.store.get(KEY_CONFIG_VERSION)) await this.syncConfig(credential);
  }

  // ---- Config sync ----------------------------------------------------------------------------

  private async syncConfig(credential: string): Promise<void> {
    const config: ConfigResponse = await this.cloud.config(credential);
    if (config.publicKeys.length) this.store.setJson(KEY_PUBLIC_KEYS, config.publicKeys);
    const keys = this.trustedKeys();
    const wanted = new Map(config.rooms.map((r) => [r.roomId, r]));

    for (const id of this.host.ids())
      if (!wanted.has(id)) {
        this.host.unload(id);
        this.store.deleteManifest(id);
        this.roomErrors.delete(id);
      }

    let allApplied = true;
    for (const assigned of config.rooms) {
      if (this.host.releaseOf(assigned.roomId) === assigned.releaseId) {
        this.roomErrors.delete(assigned.roomId);
        continue;
      }
      const ok = await this.applyRelease(credential, assigned, keys);
      if (!ok) allApplied = false;
    }
    // Only remember this config version once everything in it is running, so failures get retried.
    if (allApplied) this.store.set(KEY_CONFIG_VERSION, config.configVersion);
  }

  private async applyRelease(
    credential: string,
    assigned: AssignedRoom,
    keys: PublicKey[],
  ): Promise<boolean> {
    try {
      const raw = await this.cloud.manifest(credential, assigned.roomId, assigned.releaseId);
      const result = verifyManifest(raw, keys);
      const m = result.ok ? result.signed.manifest : null;
      const problem = !result.ok
        ? `signature check failed (${result.reason})`
        : result.signed.hash !== assigned.manifestHash
          ? 'hash does not match what was assigned'
          : m!.roomId !== assigned.roomId || m!.releaseId !== assigned.releaseId
            ? 'manifest is for a different room or release'
            : null;
      if (problem || !result.ok) {
        this.reject(assigned, problem ?? 'unknown');
        return false;
      }
      this.host.load(result.signed);
      this.store.saveManifest(result.signed);
      this.roomErrors.delete(assigned.roomId);
      return true;
    } catch (e) {
      // Network trouble: keep whatever is running and try again next heartbeat.
      this.log('warn', 'Could not download a release', { roomId: assigned.roomId, error: String(e) });
      return false;
    }
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
