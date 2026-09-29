/**
 * Exponential backoff for a driver's own reconnect loop: 1s, 2s, 4s, 8s, capped at 15s by default.
 * Every driver that keeps a persistent connection (Q-SYS, Tesira, a declarative driver's TCP
 * transport, serial) retries the same way on an unexpected disconnect, so the formula and its timer
 * bookkeeping live once here instead of once per driver.
 */
export class Reconnect {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private stopped = false;

  constructor(
    private readonly reopen: () => void,
    private readonly maxDelayMs = 15_000,
  ) {}

  /** True once `stop()` has been called (or before the first `restart()`); a driver's own connect
   * method should refuse to run while this holds, the same way it would check a local `closed` flag. */
  get closed(): boolean {
    return this.stopped;
  }

  /** The connection is confirmed working again: the next disconnect starts back at the shortest delay. */
  succeeded(): void {
    this.retries = 0;
  }

  /** Schedules the next attempt. Does nothing if one is already scheduled or `stop()` was called. */
  schedule(): void {
    if (this.stopped || this.timer) return;
    const delay = Math.min(this.maxDelayMs, 1000 * 2 ** Math.min(this.retries++, 4));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reopen();
    }, delay);
    this.timer.unref?.();
  }

  /** A driver that was closed and started again retries from scratch. */
  restart(): void {
    this.stopped = false;
  }

  /** Stops retrying for good: the driver itself is being closed. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
