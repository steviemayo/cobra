'use client';
import { useRef, useState } from 'react';

export interface LatencyPoint {
  t: string;
  avgMs: number | null;
  maxMs: number | null;
  lossPct: number;
  sent: number;
}

const W = 800;
const H = 200;
const LOSS_H = 22;
const PAD = { l: 44, r: 12, t: 10, b: 20 };

/** A "nice" top for the axis: 1, 2, 5 times a power of ten. */
function niceMax(v: number): number {
  const m = Math.max(v, 10);
  const p = 10 ** Math.floor(Math.log10(m));
  const n = m / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function tickLabel(iso: string, span: number) {
  const d = new Date(iso);
  return span <= 36 * 3_600_000
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * Average answer time of a device or site, with the slowest ping behind it and, underneath, where
 * pings went unanswered. One axis (milliseconds). Hover or touch for the values at that time.
 */
export function LatencyChart({ points }: { points: LatencyPoint[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const usable = points.filter((p) => p.avgMs !== null || p.lossPct > 0);
  if (usable.length === 0)
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        No response times yet. They appear once the gateway has pinged this for a few minutes.
      </p>
    );

  const t0 = Date.parse(points[0]!.t);
  const t1 = Date.parse(points.at(-1)!.t);
  const span = Math.max(t1 - t0, 1);
  const step =
    points.length > 1
      ? Math.min(...points.slice(1).map((p, i) => Date.parse(p.t) - Date.parse(points[i]!.t)))
      : 300_000;
  const top = niceMax(Math.max(...points.map((p) => p.maxMs ?? p.avgMs ?? 0)));
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b - LOSS_H;
  const x = (iso: string) => PAD.l + ((Date.parse(iso) - t0) / span) * plotW;
  const y = (ms: number) => PAD.t + plotH - (ms / top) * plotH;

  // A line breaks where there are no readings, instead of drawing across the gap.
  const path = (pick: (p: LatencyPoint) => number | null) => {
    let d = '';
    let prev: number | null = null;
    for (const p of points) {
      const v = pick(p);
      const tt = Date.parse(p.t);
      if (v === null) {
        prev = null;
        continue;
      }
      d += prev !== null && tt - prev <= step * 2.5 ? `L${x(p.t)},${y(v)}` : `M${x(p.t)},${y(v)}`;
      prev = tt;
    }
    return d;
  };

  const ticks = Array.from({ length: 5 }, (_, i) => new Date(t0 + (span * i) / 4).toISOString());
  const barW = Math.max(Math.min(plotW / points.length - 1, 12), 1.5);
  const shown = hover === null ? null : points[hover];

  const move = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const px = ((clientX - r.left) / r.width) * W;
    let best = 0;
    let bestD = Infinity;
    points.forEach((p, i) => {
      const dx = Math.abs(x(p.t) - px);
      if (dx < bestD) {
        bestD = dx;
        best = i;
      }
    });
    setHover(best);
  };

  return (
    <div>
      <div
        ref={box}
        className="relative"
        onPointerMove={(e) => move(e.clientX)}
        onPointerLeave={() => setHover(null)}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          role="img"
          aria-label="Response time over the chosen period, in milliseconds"
        >
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line
                x1={PAD.l}
                x2={W - PAD.r}
                y1={y(top * f)}
                y2={y(top * f)}
                className="stroke-border"
                strokeWidth={1}
              />
              <text
                x={PAD.l - 6}
                y={y(top * f) + 3}
                textAnchor="end"
                className="fill-muted-foreground text-[10px]"
              >
                {Math.round(top * f)} ms
              </text>
            </g>
          ))}
          <path
            d={path((p) => p.maxMs)}
            fill="none"
            className="stroke-muted-foreground/60"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          <path d={path((p) => p.avgMs)} fill="none" className="stroke-chart-1" strokeWidth={2} />
          {points.map((p) =>
            p.lossPct > 0 ? (
              <rect
                key={p.t}
                x={x(p.t) - barW / 2}
                y={H - PAD.b - LOSS_H + 4}
                width={barW}
                height={Math.max((Math.min(p.lossPct, 100) / 100) * (LOSS_H - 4), 2)}
                rx={1}
                className="fill-destructive"
              />
            ) : null,
          )}
          {ticks.map((t) => (
            <text
              key={t}
              x={x(t)}
              y={H - 4}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {tickLabel(t, span)}
            </text>
          ))}
          {shown && (
            <g>
              <line
                x1={x(shown.t)}
                x2={x(shown.t)}
                y1={PAD.t}
                y2={H - PAD.b}
                className="stroke-foreground/30"
              />
              {shown.avgMs !== null && (
                <circle
                  cx={x(shown.t)}
                  cy={y(shown.avgMs)}
                  r={4}
                  className="fill-chart-1 stroke-background"
                  strokeWidth={2}
                />
              )}
            </g>
          )}
        </svg>
        {shown && (
          <div
            className="pointer-events-none absolute top-1 z-10 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md"
            style={{
              left: `${(x(shown.t) / W) * 100}%`,
              transform: x(shown.t) > W * 0.7 ? 'translateX(-105%)' : 'translateX(8px)',
            }}
          >
            <div className="font-medium">
              {new Date(shown.t).toLocaleString(undefined, {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </div>
            <div>Average {shown.avgMs === null ? 'no answer' : `${shown.avgMs} ms`}</div>
            {shown.maxMs !== null && (
              <div className="text-muted-foreground">Slowest {shown.maxMs} ms</div>
            )}
            <div className={shown.lossPct > 0 ? 'text-destructive' : 'text-muted-foreground'}>
              {shown.lossPct}% lost
            </div>
          </div>
        )}
      </div>
      <p className="mt-1 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span>
          <span className="mr-1 inline-block h-0.5 w-4 bg-chart-1 align-middle" />
          Average
        </span>
        <span>
          <span className="mr-1 inline-block w-4 border-t border-dashed border-muted-foreground align-middle" />
          Slowest ping
        </span>
        <span>
          <span className="mr-1 inline-block size-2.5 rounded-sm bg-destructive align-middle" />
          Pings with no answer
        </span>
      </p>
    </div>
  );
}
