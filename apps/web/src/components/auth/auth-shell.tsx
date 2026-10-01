import { Logo } from '@/components/brand/logo';

// Static signal-flow schematic: two sources -> matrix -> two displays. Lines drift slowly.
function Schematic() {
  const node = 'fill-background stroke-border';
  const label = 'fill-muted-foreground font-mono text-[10px]';
  const line = 'stroke-brand/60';
  return (
    <svg
      viewBox="0 0 420 220"
      className="w-full max-w-md"
      role="img"
      aria-label="Signal flow: laptops to matrix to displays"
    >
      <g fill="none" strokeWidth="1.5">
        <path d="M100 60 H170 V100 H200" className={`${line} kestrel-flow`} />
        <path d="M100 160 H170 V120 H200" className={`${line} kestrel-flow`} />
        <path d="M280 100 H310 V60 H340" className={`${line} kestrel-flow`} />
        <path d="M280 120 H310 V160 H340" className={`${line} kestrel-flow`} />
      </g>
      {[
        [20, 40, 'Laptop 1'],
        [20, 140, 'Laptop 2'],
        [340, 40, 'Display 1'],
        [340, 140, 'Display 2'],
      ].map(([x, y, t]) => (
        <g key={String(t)}>
          <rect x={x as number} y={y as number} width="80" height="40" rx="6" className={node} />
          <text x={(x as number) + 40} y={(y as number) + 24} textAnchor="middle" className={label}>
            {t}
          </text>
        </g>
      ))}
      <rect x="200" y="80" width="80" height="60" rx="6" className={node} />
      <text x="240" y="114" textAnchor="middle" className={label}>
        Matrix
      </text>
      <style>{`
        .kestrel-flow { stroke-dasharray: 4 6; animation: kestrel-flow 3.2s linear infinite; }
        @keyframes kestrel-flow { to { stroke-dashoffset: -20; } }
        @media (prefers-reduced-motion: reduce) { .kestrel-flow { animation: none; } }
      `}</style>
    </svg>
  );
}

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col px-6 py-8 sm:px-12">
        <Logo />
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-12">
          {children}
        </div>
        <p className="text-xs text-muted-foreground">
          Kestrel · AV monitoring, management and analytics
        </p>
      </div>
      <aside className="hidden flex-col justify-between border-l bg-sidebar p-12 lg:flex">
        <div className="max-w-md space-y-3">
          <h2 className="text-balance text-2xl font-semibold tracking-tight">
            Every room, every device, one clear picture.
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Monitor your AV equipment, keep an asset register, hold settings in line, and see how
            your rooms are really used.
          </p>
        </div>
        <Schematic />
        <dl className="grid max-w-md grid-cols-3 gap-6 text-sm">
          {[
            ['Monitor', 'Status per room and device'],
            ['Manage', 'Assets, settings and maintenance'],
            ['Understand', 'How each room is used'],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="font-medium">{k}</dt>
              <dd className="mt-1 text-xs text-muted-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </aside>
    </div>
  );
}
