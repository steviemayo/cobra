import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn('size-7 shrink-0', className)} fill="none">
      <rect width="32" height="32" rx="8" className="fill-brand" />
      <path
        d="M9 8v16M9 16.5 22 8M13.5 14.2 23 24"
        className="stroke-brand-foreground"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Logo({ className, showName = true }: { className?: string; showName?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      {showName && <span className="text-[15px] font-semibold tracking-tight">Kestrel</span>}
    </span>
  );
}
