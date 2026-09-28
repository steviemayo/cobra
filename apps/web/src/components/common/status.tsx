import type { RouterOutputs } from '@/trpc/types';
import { cn } from '@/lib/utils';

// This is the *design* validity of a room's draft (lint errors/warnings), not its live monitoring
// state. See `HealthLevel`/`HealthPill` in `./health` for how a room is actually doing right now.
export type DesignHealth = 'none' | 'errors' | 'warnings' | 'ok';
export type DraftSummary = RouterOutputs['room']['overview'][number]['draft'];

export function designHealth(draft: DraftSummary): DesignHealth {
  if (!draft) return 'none';
  if (draft.errors > 0) return 'errors';
  if (draft.warnings > 0) return 'warnings';
  return 'ok';
}

const TONE: Record<DesignHealth, string> = {
  none: 'bg-muted-foreground/35',
  errors: 'bg-destructive',
  warnings: 'bg-warning',
  ok: 'bg-success',
};

export function designHealthLabel(health: DesignHealth, draft: DraftSummary): string {
  switch (health) {
    case 'none':
      return 'No design yet';
    case 'errors':
      return `${draft!.errors} error${draft!.errors === 1 ? '' : 's'}`;
    case 'warnings':
      return `Valid, ${draft!.warnings} warning${draft!.warnings === 1 ? '' : 's'}`;
    case 'ok':
      return 'Design valid';
  }
}

export function StatusDot({ health, className }: { health: DesignHealth; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2 shrink-0 rounded-full', TONE[health], className)}
    />
  );
}

export function DesignBadge({ draft }: { draft: DraftSummary }) {
  const health = designHealth(draft);
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <StatusDot health={health} />
      <span className={cn(health === 'none' && 'text-muted-foreground')}>
        {designHealthLabel(health, draft)}
      </span>
    </span>
  );
}

export function GatewayStatus({
  gateway,
}: {
  gateway: { name: string; status: 'pending' | 'online' | 'offline' } | null;
}) {
  if (!gateway) return <span className="text-sm text-muted-foreground">Unassigned</span>;
  const tone =
    gateway.status === 'online'
      ? 'bg-success'
      : gateway.status === 'offline'
        ? 'bg-destructive'
        : 'bg-warning';
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span aria-hidden className={cn('size-2 rounded-full', tone)} />
      {gateway.name}
    </span>
  );
}
