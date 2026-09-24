'use client';
import { useId } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

export interface NavTab {
  label: string;
  href: string;
  /** Match only this exact path (default: prefix match). */
  exact?: boolean;
  soon?: boolean;
  badge?: React.ReactNode;
}

// Route-based tabs with a sliding underline.
export function NavTabs({ tabs }: { tabs: NavTab[] }) {
  const pathname = usePathname();
  const id = useId();
  return (
    <div className="border-b">
      <nav className="flex gap-1 overflow-x-auto overflow-y-hidden" aria-label="Sections">
        {tabs.map((t) => {
          const active = t.exact
            ? pathname === t.href
            : pathname === t.href || pathname.startsWith(`${t.href}/`);
          const inner = (
            <>
              {t.label}
              {t.badge}
              {t.soon && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Soon
                </span>
              )}
              {active && (
                <motion.span
                  layoutId={`tab-underline-${id}`}
                  className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-brand"
                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                />
              )}
            </>
          );
          const cls = cn(
            'relative flex items-center gap-2 whitespace-nowrap px-3 py-2.5 text-sm transition-colors',
            active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
            t.soon && 'pointer-events-none opacity-60',
          );
          return t.soon ? (
            <span key={t.label} className={cls} aria-disabled>
              {inner}
            </span>
          ) : (
            <Link
              key={t.label}
              href={t.href}
              className={cls}
              aria-current={active ? 'page' : undefined}
            >
              {inner}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export interface ValueTab<T extends string> {
  id: T;
  label: string;
  errors?: number;
  warnings?: number;
}

// State-based tabs (no routing) with the same sliding underline.
export function ValueTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: ValueTab<T>[];
  value: T;
  onChange: (id: T) => void;
}) {
  const id = useId();
  return (
    <div className="border-b">
      <div role="tablist" className="flex gap-1 overflow-x-auto overflow-y-hidden">
        {tabs.map((t) => {
          const active = t.id === value;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => onChange(t.id)}
              className={cn(
                'relative flex items-center gap-2 whitespace-nowrap px-3 py-2.5 text-sm transition-colors',
                active
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
              {!!t.errors && (
                <span className="rounded-full bg-destructive/15 px-1.5 text-xs text-destructive">
                  {t.errors}
                </span>
              )}
              {!t.errors && !!t.warnings && (
                <span className="rounded-full bg-warning/20 px-1.5 text-xs text-amber-800 dark:text-amber-200">
                  {t.warnings}
                </span>
              )}
              {active && (
                <motion.span
                  layoutId={`value-tab-underline-${id}`}
                  className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-brand"
                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
