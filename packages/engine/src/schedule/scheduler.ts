import type { RoomModel, Trigger } from '@kestrel/model';
import { cronMatches, isValidTimezone, localParts, parseCron, type Cron } from './cron';

type ScheduleTrigger = Extract<Trigger, { type: 'schedule' }>;

interface Entry {
  trigger: ScheduleTrigger;
  cron: Cron;
  timezone: string;
  lastKey: string | null;
}

export interface SchedulerOptions {
  /** Called when a schedule comes due. */
  fire: (trigger: ScheduleTrigger) => void;
  now?: () => Date;
  /** How often to look. Half a minute never misses a minute. */
  everyMs?: number;
}

/**
 * Fires a room's schedule triggers on time. It looks at the clock twice a minute and fires each
 * schedule at most once per matching minute, so a slow tick or a clock check inside the same
 * minute can never run something twice. Schedules with a broken expression are ignored (the
 * validator reports them before a release can be published).
 */
export class TriggerScheduler {
  private readonly entries: Entry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => Date;

  constructor(
    model: Pick<RoomModel, 'triggers'>,
    private readonly opts: SchedulerOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
    for (const t of model.triggers) {
      if (t.type !== 'schedule' || !t.enabled) continue;
      try {
        if (!isValidTimezone(t.timezone)) continue;
        // A schedule created inside its own minute (a redeploy, a gateway restart) has already had its turn.
        this.entries.push({
          trigger: t,
          cron: parseCron(t.cron),
          timezone: t.timezone,
          lastKey: localParts(this.now(), t.timezone).key,
        });
      } catch {
        // ignored, see above
      }
    }
  }

  get count() {
    return this.entries.length;
  }

  start() {
    if (this.timer || this.entries.length === 0) return;
    this.timer = setInterval(() => this.tick(), this.opts.everyMs ?? 30_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Checks every schedule against the clock. Exposed so tests (and a paused laptop waking) can call it. */
  tick() {
    const at = this.now();
    for (const e of this.entries) {
      const parts = localParts(at, e.timezone);
      if (e.lastKey === parts.key || !cronMatches(e.cron, parts)) continue;
      e.lastKey = parts.key;
      try {
        this.opts.fire(e.trigger);
      } catch {
        // a failing action must not stop the other schedules
      }
    }
  }
}
