import { connect } from 'node:net';
import { systemPing, type Ping } from './probe';

// Fast failure detection: a device that stops answering is confirmed down on the gateway, a few
// seconds after it goes quiet, and the gateway tells the cloud at once instead of waiting for the next
// heartbeat. Each device is checked on a steady beat; the first miss starts a burst of quick checks,
// and only a run of misses in a row confirms it. One dropped packet never raises anything, and a
// device that comes back must answer a couple of times in a row before it counts as up again.

/** Time between checks of a device that is up. */
export const CHECK_EVERY_MS = 5_000;
/** Time between checks while a device is suspect, and once it is confirmed down. */
export const BURST_EVERY_MS = 1_000;
export const CHECK_TIMEOUT_MS = 1_000;
/** Misses in a row that confirm a device is down. */
export const FAILS_TO_CONFIRM = 3;
/** Answers in a row that bring a confirmed-down device back. */
export const OKS_TO_RECOVER = 2;
/** A driver that keeps saying "offline" this long is believed even when the device still answers checks. */
export const DRIVER_HOLD_MS = 15_000;
const TICK_MS = 500;
const MAX_PARALLEL = 32;

/** One check: true when the device answered. */
export type Reach = (host: string, port: number | undefined, timeoutMs: number) => Promise<boolean>;

/** A TCP connect when the device has a port (cheap, no process), otherwise one ping. */
export const defaultReach =
  (ping: Ping = systemPing): Reach =>
  (host, port, timeoutMs) =>
    port
      ? new Promise((resolve) => {
          const socket = connect({ host, port });
          const done = (ok: boolean) => {
            socket.destroy();
            resolve(ok);
          };
          socket.setTimeout(timeoutMs, () => done(false));
          socket.on('connect', () => done(true));
          socket.on('error', () => done(false));
        })
      : ping(host, timeoutMs).then(
          (ms) => ms !== null,
          () => false,
        );

export interface Verdict {
  online: boolean;
  /** The gateway has already waited out a run of misses, so the cloud need not wait again. */
  confirmed: boolean;
  /** How long the device has been quiet, when it is confirmed down. */
  offlineForMs?: number;
}

export interface TrackOptions {
  everyMs?: number;
  failsToConfirm?: number;
}

type Status = 'up' | 'suspect' | 'down';

interface Target {
  host: string;
  port: number | undefined;
  everyMs: number;
  need: number;
  status: Status;
  /** It has answered at least once, so silence after that is a fault, not a blocked check. */
  proven: boolean;
  fails: number;
  oks: number;
  firstFailAt: number;
  nextAt: number;
  driverOfflineSince: number | null;
  busy: boolean;
}

export class FastFail {
  private readonly targets = new Map<string, Target>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly opts: {
      reach?: Reach;
      /** What the device's driver says right now (undefined when it has not said). */
      driverOnline?: (deviceId: string) => boolean | undefined;
      /** A device was confirmed down, or came back. */
      onChange?: (deviceId: string, down: boolean) => void;
      now?: () => number;
    } = {},
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  track(deviceId: string, host: string | undefined, port?: number, options: TrackOptions = {}) {
    const h = host?.trim();
    if (!h) return void this.targets.delete(deviceId);
    const p = port && Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
    const everyMs = clamp(options.everyMs ?? CHECK_EVERY_MS, 1_000, 60_000);
    const need = clamp(Math.round(options.failsToConfirm ?? FAILS_TO_CONFIRM), 2, 10);
    const cur = this.targets.get(deviceId);
    if (cur && cur.host === h && cur.port === p) {
      cur.everyMs = everyMs;
      cur.need = need;
      return;
    }
    this.targets.set(deviceId, {
      host: h,
      port: p,
      everyMs,
      need,
      status: 'up',
      proven: false,
      fails: 0,
      oks: 0,
      firstFailAt: 0,
      nextAt: this.now(),
      driverOfflineSince: null,
      busy: false,
    });
  }

  untrack(deviceId: string) {
    this.targets.delete(deviceId);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.run(), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * What the gateway reports for a device, or undefined when it is not judged here (not tracked, or
   * never yet answered a check): then the driver's own state stands and the cloud applies its grace.
   */
  verdict(deviceId: string): Verdict | undefined {
    const t = this.targets.get(deviceId);
    if (!t || !t.proven) return undefined;
    if (t.status === 'down')
      return {
        online: false,
        confirmed: true,
        offlineForMs: Math.max(0, this.now() - t.firstFailAt),
      };
    // Suspect (a miss or two) is not reported: nothing leaves the gateway until it is confirmed.
    return { online: true, confirmed: false };
  }

  /** Runs every check that is due, a few at a time. Skips if the last pass is still going. */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.now();
      const due: [string, Target][] = [];
      for (const [id, t] of this.targets) {
        const driver = this.opts.driverOnline?.(id);
        t.driverOfflineSince = driver === false ? (t.driverOfflineSince ?? now) : null;
        if (
          t.proven &&
          t.status !== 'down' &&
          t.driverOfflineSince !== null &&
          now - t.driverOfflineSince >= DRIVER_HOLD_MS
        )
          this.confirmDown(id, t, t.driverOfflineSince);
        if (!t.busy && t.nextAt <= now) due.push([id, t]);
      }
      const reach = this.opts.reach ?? defaultReach();
      const worker = async () => {
        for (let next = due.shift(); next; next = due.shift()) {
          const [id, t] = next;
          t.busy = true;
          const ok = await reach(t.host, t.port, CHECK_TIMEOUT_MS).catch(() => false);
          t.busy = false;
          // The device may have been dropped or re-addressed while the check was out.
          if (this.targets.get(id) === t) this.sample(id, t, ok);
        }
      };
      await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, due.length) }, worker));
    } finally {
      this.running = false;
    }
  }

  private sample(id: string, t: Target, ok: boolean) {
    const now = this.now();
    if (!t.proven) {
      if (ok) t.proven = true;
      t.nextAt = now + t.everyMs;
      return;
    }
    if (ok) {
      t.fails = 0;
      t.oks++;
      if (t.status === 'suspect') t.status = 'up';
      else if (
        t.status === 'down' &&
        t.oks >= OKS_TO_RECOVER &&
        this.opts.driverOnline?.(id) !== false
      ) {
        t.status = 'up';
        this.opts.onChange?.(id, false);
      }
      t.nextAt = now + (t.status === 'down' ? BURST_EVERY_MS : t.everyMs);
      return;
    }
    t.oks = 0;
    t.fails++;
    if (t.status === 'up') {
      t.status = 'suspect';
      t.firstFailAt = now;
    }
    if (t.status === 'suspect' && t.fails >= t.need) this.confirmDown(id, t, t.firstFailAt);
    t.nextAt = now + (t.status === 'down' ? t.everyMs : BURST_EVERY_MS);
  }

  private confirmDown(id: string, t: Target, since: number) {
    t.status = 'down';
    t.firstFailAt = since;
    t.oks = 0;
    this.opts.onChange?.(id, true);
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
