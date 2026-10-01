'use client';
import { useMemo } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

// The timing rules of an alert channel, as a form. `draftFromRules` and `rulesFromDraft` convert to
// and from what the server stores (see server/alert-rules.ts); an empty form means no rules.
export interface Rules {
  window?: { days: number[]; start: string; end: string; tz: string };
  delayMinutes?: number;
  repeatMinutes?: number;
  maxRepeats?: number;
}

export interface RulesDraft {
  windowOn: boolean;
  days: number[];
  start: string;
  end: string;
  tz: string;
  delay: string;
  repeat: string;
  maxRepeats: string;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function draftFromRules(r: Rules | null | undefined): RulesDraft {
  return {
    windowOn: !!r?.window,
    days: r?.window?.days ?? [0, 1, 2, 3, 4],
    start: r?.window?.start ?? '09:00',
    end: r?.window?.end ?? '17:00',
    tz: r?.window?.tz ?? browserZone(),
    delay: r?.delayMinutes ? String(r.delayMinutes) : '',
    repeat: r?.repeatMinutes ? String(r.repeatMinutes) : '',
    maxRepeats: r?.maxRepeats ? String(r.maxRepeats) : '',
  };
}

const whole = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : undefined);

/** What the form says, or null for no rules. Only the parts that are switched on are included. */
export function rulesFromDraft(d: RulesDraft): Rules | null {
  const delay = whole(d.delay);
  const repeat = whole(d.repeat);
  const rules: Rules = {
    ...(d.windowOn && d.days.length
      ? { window: { days: [...d.days].sort(), start: d.start, end: d.end, tz: d.tz } }
      : {}),
    ...(delay ? { delayMinutes: delay } : {}),
    ...(repeat
      ? {
          repeatMinutes: repeat,
          ...(whole(d.maxRepeats) ? { maxRepeats: whole(d.maxRepeats) } : {}),
        }
      : {}),
  };
  return Object.keys(rules).length ? rules : null;
}

/** A sentence about anything in the form the server would refuse, or null. */
export function draftProblem(d: RulesDraft): string | null {
  if (d.windowOn && d.days.length === 0) return 'Choose at least one day';
  const delay = whole(d.delay);
  if (d.delay.trim() && (delay === undefined || delay > 1440))
    return 'Wait time must be 0 to 1440 minutes';
  const repeat = whole(d.repeat);
  if (d.repeat.trim() && (repeat === undefined || repeat < 5 || repeat > 1440))
    return 'Repeat every 5 to 1440 minutes';
  const max = whole(d.maxRepeats);
  if (d.maxRepeats.trim() && (max === undefined || max < 1 || max > 20))
    return 'Repeat 1 to 20 times';
  return null;
}

export function RulesFields({
  value,
  onChange,
}: {
  value: RulesDraft;
  onChange: (d: RulesDraft) => void;
}) {
  const set = (patch: Partial<RulesDraft>) => onChange({ ...value, ...patch });
  const problem = useMemo(() => draftProblem(value), [value]);
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox checked={value.windowOn} onCheckedChange={(on) => set({ windowOn: !!on })} />
          Only alert at certain times
        </label>
        {value.windowOn && (
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
              {DAYS.map((d, i) => {
                const on = value.days.includes(i);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      set({ days: on ? value.days.filter((x) => x !== i) : [...value.days, i] })
                    }
                    className={cn(
                      'rounded-md border px-2.5 py-1 text-xs',
                      on
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="rule-start">From</Label>
                <Input
                  id="rule-start"
                  type="time"
                  value={value.start}
                  onChange={(e) => set({ start: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rule-end">Until</Label>
                <Input
                  id="rule-end"
                  type="time"
                  value={value.end}
                  onChange={(e) => set({ end: e.target.value })}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Times are in {value.tz}. An end earlier than the start runs overnight. A problem that
              starts outside these hours is sent when they begin, if it is still there.
            </p>
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="rule-delay">Wait before alerting (minutes)</Label>
          <Input
            id="rule-delay"
            inputMode="numeric"
            placeholder="Straight away"
            value={value.delay}
            onChange={(e) => set({ delay: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Skipped if someone acknowledges the problem or it clears first.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rule-repeat">Repeat every (minutes)</Label>
          <Input
            id="rule-repeat"
            inputMode="numeric"
            placeholder="Don’t repeat"
            value={value.repeat}
            onChange={(e) => set({ repeat: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">Until acknowledged or cleared.</p>
        </div>
      </div>
      {value.repeat.trim() && (
        <div className="max-w-40 space-y-1.5">
          <Label htmlFor="rule-max">At most (times)</Label>
          <Input
            id="rule-max"
            inputMode="numeric"
            placeholder="5"
            value={value.maxRepeats}
            onChange={(e) => set({ maxRepeats: e.target.value })}
          />
        </div>
      )}
      {problem && <p className="text-sm text-destructive">{problem}</p>}
    </div>
  );
}
