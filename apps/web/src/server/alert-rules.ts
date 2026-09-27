import { z } from 'zod';

// When an alert channel may speak, and how it escalates. A channel with no rules alerts at once,
// always, as it always did. With rules it can:
//   - only alert inside a window (an on-call rota is a channel per person, each with its days and
//     hours; quiet hours are a channel whose window leaves the night out). An alert that comes up
//     outside the window is held and sent when the window opens, if the problem is still there
//   - wait some minutes before alerting, and not alert at all if someone acknowledges it or it
//     clears first (an escalation channel: "tell the manager if nobody has picked this up in 30 minutes")
//   - repeat every so often until someone acknowledges it or it clears
// These are plain functions of the rules, the incident and what has already been sent.

/** Whether a time zone name is one the runtime knows. */
function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 08:30');

export const ChannelRules = z.object({
  window: z
    .object({
      /** Monday is 0. */
      days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      start: time,
      end: time,
      tz: z.string().min(1).max(64).refine(validZone, 'Unknown time zone'),
    })
    .optional(),
  delayMinutes: z.number().int().min(0).max(1440).optional(),
  repeatMinutes: z.number().int().min(5).max(1440).optional(),
  maxRepeats: z.number().int().min(1).max(20).optional(),
});
export type ChannelRules = z.infer<typeof ChannelRules>;

export const DEFAULT_MAX_REPEATS = 5;

export const hasRules = (r: ChannelRules | undefined | null): r is ChannelRules =>
  !!r && (!!r.window || (r.delayMinutes ?? 0) > 0 || !!r.repeatMinutes);

const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/** Local weekday (Monday is 0) and minutes since midnight in a zone. */
function localParts(now: Date, tz: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'));
  return { day, minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}

/** Whether a time is inside the window. Overnight windows (end before start) run into the next day. */
export function inWindow(w: NonNullable<ChannelRules['window']>, now: Date): boolean {
  const { day, minutes } = localParts(now, w.tz);
  const start = toMinutes(w.start);
  const end = toMinutes(w.end);
  if (start === end) return w.days.includes(day);
  if (start < end) return w.days.includes(day) && minutes >= start && minutes < end;
  return (w.days.includes(day) && minutes >= start) || (w.days.includes((day + 6) % 7) && minutes < end);
}

export type Due = 'opened' | 'reminder' | null;

export interface SentRecord {
  event: string;
  at: Date;
}

/** What, if anything, this channel should send now about an incident that is still open. */
export function dueNow(input: {
  rules: ChannelRules;
  openedAt: Date;
  acknowledged: boolean;
  /** What this channel has already sent about the incident. */
  sent: SentRecord[];
  now: Date;
}): Due {
  const { rules, sent, now } = input;
  const inside = !rules.window || inWindow(rules.window, now);
  const first = sent.filter((s) => s.event === 'opened');
  const reminders = sent.filter((s) => s.event === 'reminder');
  if (first.length === 0) {
    if (input.acknowledged) return null;
    if (now.getTime() < input.openedAt.getTime() + (rules.delayMinutes ?? 0) * 60_000) return null;
    return inside ? 'opened' : null;
  }
  if (!rules.repeatMinutes || input.acknowledged) return null;
  if (reminders.length >= (rules.maxRepeats ?? DEFAULT_MAX_REPEATS)) return null;
  const last = Math.max(...[...first, ...reminders].map((s) => s.at.getTime()));
  if (now.getTime() < last + rules.repeatMinutes * 60_000) return null;
  return inside ? 'reminder' : null;
}

/** The rules in a sentence, for the channel list. */
export function describeRules(r: ChannelRules | undefined | null): string | null {
  if (!hasRules(r)) return null;
  const parts: string[] = [];
  if (r.window) {
    const days = [...r.window.days].sort();
    const range =
      days.length === 7
        ? 'every day'
        : days.length === 5 && days.join() === '0,1,2,3,4'
          ? 'weekdays'
          : days.map((d) => DAY[d]).join(', ');
    parts.push(`${range} ${r.window.start} to ${r.window.end} (${r.window.tz})`);
  }
  if (r.delayMinutes) parts.push(`after ${r.delayMinutes} min if nobody has acknowledged it`);
  if (r.repeatMinutes)
    parts.push(`repeats every ${r.repeatMinutes} min until acknowledged (up to ${r.maxRepeats ?? DEFAULT_MAX_REPEATS} times)`);
  return parts.join(', ');
}
