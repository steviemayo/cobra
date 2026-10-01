'use client';
import { cn } from '@/lib/utils';

// Small, dependency-free charts drawn with the app's own colours (the brand colour and the muted
// foreground), so they follow the theme and the organisation's accent.

const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const minutesLabel = (m: number) => {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
};

/** Minutes in use for each day, as columns. Days with nothing show as an empty slot. */
export function DailyBars({
  days,
  height = 96,
}: {
  days: { day: string; minutes: number; workMinutes: number }[];
  height?: number;
}) {
  const max = Math.max(60, ...days.map((d) => d.minutes));
  if (days.length === 0)
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        Nothing in use in this period.
      </p>
    );
  return (
    <div>
      <div
        className="flex items-end gap-px"
        style={{ height }}
        role="img"
        aria-label="Minutes in use each day"
      >
        {days.map((d) => {
          const total = (d.minutes / max) * 100;
          const work = d.minutes ? (d.workMinutes / d.minutes) * 100 : 0;
          return (
            <div
              key={d.day}
              className="group relative flex min-w-0 flex-1 flex-col justify-end"
              style={{ height: '100%' }}
              title={`${d.day}: ${minutesLabel(d.minutes)} in use, ${minutesLabel(d.workMinutes)} in working hours`}
            >
              <div className="w-full overflow-hidden rounded-t-sm" style={{ height: `${total}%` }}>
                <div className="w-full bg-brand" style={{ height: `${work}%` }} />
                <div
                  className="w-full bg-muted-foreground/40"
                  style={{ height: `${100 - work}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
        <span>{days[0]!.day}</span>
        <span>{days.at(-1)!.day}</span>
      </div>
      <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-brand" /> In working hours
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-muted-foreground/40" /> Outside working hours
        </span>
      </div>
    </div>
  );
}

/** Busy hours: each cell is a day of the week and an hour of the day, darker when the room is used more. */
export function Heatmap({ heat }: { heat: number[][] }) {
  const max = Math.max(1, ...heat.flat());
  // Monday first reads better than Sunday first.
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[32rem]">
        <div
          className="ml-9 grid grid-cols-24 text-[10px] text-muted-foreground"
          style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}
        >
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="text-center">
              {h % 3 === 0 ? h : ''}
            </span>
          ))}
        </div>
        {order.map((dow) => (
          <div key={dow} className="flex items-center gap-1 py-px">
            <span className="w-8 shrink-0 text-[11px] text-muted-foreground">{DAY_LABEL[dow]}</span>
            <div
              className="grid flex-1 gap-px"
              style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}
            >
              {heat[dow]!.map((v, h) => (
                <div
                  key={h}
                  className="h-5 rounded-[2px] bg-muted/50"
                  title={`${DAY_LABEL[dow]} ${String(h).padStart(2, '0')}:00, ${minutesLabel(v)} in use in total`}
                  style={
                    v > 0
                      ? {
                          backgroundColor: `color-mix(in oklab, var(--brand) ${Math.round(15 + (v / max) * 85)}%, transparent)`,
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A number over time as a line, for a device level such as volume. */
export function LineSeries({
  points,
  from,
  to,
  unit,
}: {
  points: { at: number; value: string }[];
  from: number;
  to: number;
  unit?: string;
}) {
  const values = points.map((p) => Number(p.value));
  const lo = Math.min(...values, 0);
  const hi = Math.max(...values, 1);
  const w = 600;
  const h = 80;
  const x = (t: number) => ((t - from) / Math.max(1, to - from)) * w;
  const y = (v: number) => h - ((v - lo) / Math.max(1e-9, hi - lo)) * (h - 8) - 4;
  // A stepped line: a level holds until the next change.
  let d = '';
  points.forEach((p, i) => {
    const px = x(Math.max(from, p.at));
    const py = y(Number(p.value));
    d += i === 0 ? `M${px},${py}` : `L${px},${y(Number(points[i - 1]!.value))}L${px},${py}`;
  });
  const last = points.at(-1);
  if (last) d += `L${w},${y(Number(last.value))}`;
  return (
    <div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-20 w-full text-brand"
        preserveAspectRatio="none"
        role="img"
        aria-label="Level over time"
      >
        <line x1="0" y1={h - 1} x2={w} y2={h - 1} className="stroke-border" strokeWidth="1" />
        <path
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>
          {lo}
          {unit}
        </span>
        <span>
          {hi}
          {unit}
        </span>
      </div>
    </div>
  );
}

const STATE_TONE = [
  'bg-brand',
  'bg-warning',
  'bg-success',
  'bg-destructive',
  'bg-muted-foreground/60',
];

/** A state over time as a coloured strip, with the time spent in each state underneath. */
export function StateStrip({
  points,
  from,
  to,
  minutesByValue,
  goodValue,
}: {
  points: { at: number; value: string }[];
  from: number;
  to: number;
  minutesByValue: Record<string, number>;
  /** The value that means fine (true for online), coloured green. */
  goodValue?: string;
}) {
  const values = Object.keys(minutesByValue);
  const tone = (v: string) =>
    goodValue !== undefined
      ? v === goodValue
        ? 'bg-success'
        : 'bg-destructive'
      : STATE_TONE[values.indexOf(v) % STATE_TONE.length];
  const span = Math.max(1, to - from);
  return (
    <div>
      <div
        className="flex h-5 overflow-hidden rounded-sm bg-muted"
        role="img"
        aria-label="State over time"
      >
        {points.map((p, i) => {
          const start = Math.max(from, p.at);
          const end = points[i + 1]?.at ?? to;
          return (
            <div
              key={`${p.at}-${i}`}
              className={cn('h-full', tone(p.value))}
              style={{ width: `${((end - start) / span) * 100}%` }}
              title={`${p.value}, from ${new Date(start).toLocaleString('en-AU')}`}
            />
          );
        })}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1.5">
            <span className={cn('size-2 rounded-sm', tone(v))} />
            {v} · {minutesLabel(minutesByValue[v]!)}
          </span>
        ))}
      </div>
    </div>
  );
}
