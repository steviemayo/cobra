import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import type { DeviceLatency } from '@kestrel/model';

// Response times: the gateway pings each polled device on a steady beat and keeps the results until
// the next heartbeat takes them. A device that slows down, or starts dropping pings, is often the
// first sign of a network problem that will soon hurt the AV systems on it.

/** Time between pings of one device. */
export const PROBE_EVERY_MS = 10_000;
/** A ping with no answer by then counts as lost. */
export const PROBE_TIMEOUT_MS = 2_000;
/** Pings in flight at once, so a big estate never opens a storm of processes. */
const MAX_PARALLEL = 8;

/** One ping: the round trip in milliseconds, or null when there was no answer. */
export type Ping = (host: string, timeoutMs: number) => Promise<number | null>;

const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/**
 * Only a plain address or host name is ever handed to the ping command: no spaces, no leading dash,
 * and never a cloud metadata (link-local) address, which no device is at.
 */
export function pingable(host: string, allowLocal = false): boolean {
  const h = host.trim().replace(/^\[|\]$/g, '');
  if (!h || h.length > 253 || h.startsWith('-')) return false;
  const kind = isIP(h);
  if (kind === 0 && !HOSTNAME.test(h)) return false;
  if (
    !allowLocal &&
    ((kind === 4 && h.startsWith('169.254.')) || (kind === 6 && /^fe[89ab]/i.test(h)))
  )
    return false;
  return true;
}

/** Reads the round trip out of the system ping's output, whatever language it answers in. */
export function parsePing(output: string): number | null {
  // An answered ping carries a TTL on Windows and Linux alike. A "destination unreachable" reply
  // from a router has none, even though the Windows ping command exits cleanly for it.
  if (!/ttl/i.test(output)) return null;
  const times = [...output.matchAll(/[=<]\s*(\d+(?:[.,]\d+)?)\s*ms/gi)];
  const last = times.at(-1);
  if (!last) return null;
  const ms = Number(last[1]!.replace(',', '.'));
  return Number.isFinite(ms) ? ms : null;
}

/** The real thing: the system's own ping, one echo. */
export const systemPing: Ping = (host, timeoutMs) =>
  new Promise((resolve) => {
    const win = process.platform === 'win32';
    const args = win
      ? ['-n', '1', '-w', String(timeoutMs), host]
      : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), host];
    const started = performance.now();
    execFile('ping', args, { timeout: timeoutMs + 3_000, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      const parsed = parsePing(String(stdout));
      if (parsed === null)
        return resolve(/ttl/i.test(String(stdout)) ? performance.now() - started : null);
      resolve(parsed);
    });
  });

interface Target {
  host: string;
  sent: number;
  ok: number;
  sum: number;
  /** It has answered at least once, so silence after that is loss, not blocked pings. */
  answered: boolean;
  min: number;
  max: number;
}

export class Prober {
  private readonly targets = new Map<string, Target>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly ping: Ping = systemPing,
    private readonly everyMs = PROBE_EVERY_MS,
  ) {}

  /** Starts (or changes) pinging a device. A host that can't be pinged is simply not tracked. */
  track(deviceId: string, host: string | undefined, allowLocal = false) {
    const h = host?.trim().replace(/^\[|\]$/g, '');
    const current = this.targets.get(deviceId);
    if (!h || !pingable(h, allowLocal)) return void this.targets.delete(deviceId);
    if (current?.host === h) return;
    this.targets.set(deviceId, {
      host: h,
      sent: 0,
      ok: 0,
      sum: 0,
      answered: false,
      min: Infinity,
      max: 0,
    });
  }

  untrack(deviceId: string) {
    this.targets.delete(deviceId);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.round(), this.everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Pings every tracked device once, a few at a time. Skips a round if the last is still going. */
  async round(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const queue = [...this.targets.entries()];
      const worker = async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          const [id, t] = next;
          const ms = await this.ping(t.host, PROBE_TIMEOUT_MS).catch(() => null);
          // The device may have been dropped or re-addressed while the ping was out.
          if (this.targets.get(id) !== t) continue;
          t.sent++;
          if (ms !== null) {
            t.ok++;
            t.answered = true;
            t.sum += ms;
            t.min = Math.min(t.min, ms);
            t.max = Math.max(t.max, ms);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, queue.length) }, worker));
    } finally {
      this.running = false;
    }
  }

  /**
   * What a device's pings since the last call came to, and starts a new window. Undefined when
   * nothing was sent, or when the device is online yet has never answered a ping: its pings are
   * blocked, which says nothing about the network.
   */
  take(deviceId: string, online: boolean): DeviceLatency | undefined {
    const t = this.targets.get(deviceId);
    if (!t || t.sent === 0) return undefined;
    const out: DeviceLatency | undefined =
      t.ok === 0 && online && !t.answered
        ? undefined
        : {
            sent: t.sent,
            ok: t.ok,
            ...(t.ok > 0 && {
              minMs: round1(t.min),
              avgMs: round1(t.sum / t.ok),
              maxMs: round1(t.max),
            }),
          };
    t.sent = 0;
    t.ok = 0;
    t.sum = 0;
    t.min = Infinity;
    t.max = 0;
    return out;
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;
