'use client';
import { useQuery } from '@tanstack/react-query';
import { Check, Minus, Pencil, Plus, X } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useOrg } from '@/components/shell/org-context';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

export type SyncState = RouterOutputs['deployment']['roomStatus']['state'];
export type DiffChange = RouterOutputs['release']['diff']['changes'][number];

const SYNC: Record<SyncState, { label: string; tone: string; pulse?: boolean }> = {
  in_sync: { label: 'In sync', tone: 'bg-success' },
  deploying: { label: 'Deploying', tone: 'bg-warning', pulse: true },
  failed: { label: 'Deploy failed', tone: 'bg-destructive' },
  drifted: { label: 'Drifted', tone: 'bg-warning' },
  unreachable: { label: 'Gateway offline', tone: 'bg-destructive' },
  not_deployed: { label: 'Not deployed', tone: 'bg-muted-foreground/35' },
};

export const SYNC_HELP: Record<SyncState, string> = {
  in_sync: 'The gateway is running the release this room is set to.',
  deploying: 'A release is on its way to the gateway.',
  failed: 'The gateway refused the release and is still running the previous one.',
  drifted: 'The gateway is running something other than the release this room is set to.',
  unreachable: 'The gateway is not in touch, so what it is running is unknown.',
  not_deployed: 'Nothing has been deployed to a gateway yet.',
};

export function SyncBadge({ state, className }: { state: SyncState; className?: string }) {
  const s = SYNC[state];
  return (
    <span className={cn('inline-flex items-center gap-2 text-sm', className)} title={SYNC_HELP[state]}>
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', s.tone, s.pulse && 'animate-pulse')} />
      <span className={cn(state === 'not_deployed' && 'text-muted-foreground')}>{s.label}</span>
    </span>
  );
}

export const STATUS_LABEL: Record<string, string> = {
  scheduled: 'Scheduled',
  pending: 'Waiting for gateway',
  downloading: 'Downloading',
  verifying: 'Verifying',
  staging: 'Preparing',
  health_check: 'Checking devices',
  active: 'Live',
  failed: 'Failed',
  rolled_back: 'Rolled back',
  cancelled: 'Cancelled',
  superseded: 'Replaced',
};

const STATUS_TONE: Record<string, string> = {
  active: 'bg-success',
  failed: 'bg-destructive',
  rolled_back: 'bg-destructive',
  scheduled: 'bg-muted-foreground/50',
  cancelled: 'bg-muted-foreground/35',
  superseded: 'bg-muted-foreground/35',
};

export function StatusPill({ status }: { status: string }) {
  const inFlight = !STATUS_TONE[status];
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span
        aria-hidden
        className={cn('size-2 shrink-0 rounded-full', STATUS_TONE[status] ?? 'bg-warning', inFlight && 'animate-pulse')}
      />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

const STEPS = [
  { stage: 'downloading', label: 'Download' },
  { stage: 'verifying', label: 'Verify signature' },
  { stage: 'staging', label: 'Prepare room' },
  { stage: 'health_check', label: 'Check devices' },
  { stage: 'active', label: 'Go live' },
] as const;

const time = (d: Date | string) =>
  new Date(d).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', second: '2-digit' });

/** Where a deployment got to, step by step, with the gateway's own timestamps. */
export function StageTimeline({
  status,
  events,
  error,
}: {
  status: string;
  events: { stage: string; at: Date | string }[];
  error?: string | null;
}) {
  const at = new Map(events.map((e) => [e.stage, e.at]));
  const refused = status === 'failed' || status === 'rolled_back';
  const current = STEPS.findIndex((s) => s.stage === status);
  // The step that was under way when a deployment was refused is the last one it reached.
  const failedAt = refused ? STEPS.findLastIndex((s) => at.has(s.stage)) : -1;
  return (
    <ol className="space-y-2">
      {STEPS.map((step, i) => {
        const done = at.has(step.stage) && !(refused && i === failedAt) && status !== step.stage;
        const isCurrent = current === i && !refused && status !== 'active';
        const isFailed = refused && i === failedAt;
        const reached = at.get(step.stage);
        return (
          <li key={step.stage} className="flex items-center gap-3 text-sm">
            <span
              className={cn(
                'grid size-5 shrink-0 place-items-center rounded-full border',
                (done || (status === 'active' && step.stage === 'active')) &&
                  'border-success bg-success text-background',
                isCurrent && 'border-warning',
                isFailed && 'border-destructive bg-destructive text-background',
              )}
            >
              {isFailed ? (
                <X className="size-3" />
              ) : done || (status === 'active' && step.stage === 'active') ? (
                <Check className="size-3" />
              ) : isCurrent ? (
                <span className="size-2 animate-pulse rounded-full bg-warning" />
              ) : null}
            </span>
            <span className={cn(!done && !isCurrent && !isFailed && status !== 'active' && 'text-muted-foreground')}>
              {step.label}
            </span>
            {reached && <span className="tabular ml-auto text-xs text-muted-foreground">{time(reached)}</span>}
          </li>
        );
      })}
      {refused && (
        <li className="pt-1 text-sm text-destructive">
          {error ?? 'The gateway refused this release.'}
          {status === 'rolled_back' && (
            <span className="block text-muted-foreground">The previous release is still running.</span>
          )}
        </li>
      )}
    </ol>
  );
}

const AREA_LABEL: Record<DiffChange['area'], string> = {
  device: 'Devices',
  connection: 'Connections',
  group: 'Groups',
  state: 'States',
  activity: 'Activities',
  trigger: 'Triggers',
  setting: 'Room settings',
};

const KIND_ICON = { added: Plus, removed: Minus, changed: Pencil } as const;
const KIND_TONE = { added: 'text-success', removed: 'text-destructive', changed: 'text-warning' } as const;

export function ChangeList({ changes }: { changes: DiffChange[] }) {
  if (changes.length === 0) return <p className="text-sm text-muted-foreground">No changes.</p>;
  const areas = [...new Set(changes.map((c) => c.area))];
  return (
    <div className="space-y-3">
      {areas.map((area) => (
        <div key={area}>
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {AREA_LABEL[area]}
          </h4>
          <ul className="space-y-1">
            {changes
              .filter((c) => c.area === area)
              .map((c, i) => {
                const Icon = KIND_ICON[c.kind];
                return (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <Icon aria-label={c.kind} className={cn('mt-0.5 size-3.5 shrink-0', KIND_TONE[c.kind])} />
                    <span className="min-w-0">
                      <span className="font-medium">{c.label}</span>
                      {c.details.length > 0 && (
                        <span className="text-muted-foreground"> — {c.details.join('; ')}</span>
                      )}
                    </span>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** What a release (or the current design) changes compared with another. */
export function DiffView({
  roomId,
  toReleaseId,
  fromReleaseId,
  className,
}: {
  roomId: string;
  toReleaseId?: string;
  fromReleaseId?: string | null;
  className?: string;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const diff = useQuery(trpc.release.diff.queryOptions({ orgId, roomId, toReleaseId, fromReleaseId }));
  if (diff.isPending) return <Skeleton className={cn('h-16 w-full', className)} />;
  if (diff.isError) return <p className="text-sm text-destructive">{diff.error.message}</p>;
  return (
    <div className={cn('space-y-3', className)}>
      <p className="text-xs text-muted-foreground">
        {diff.data.from === null ? 'First release' : `Compared with release ${diff.data.from}`}
        {' · '}
        {diff.data.summary}
      </p>
      <div className="max-h-72 overflow-y-auto pr-1">
        <ChangeList changes={diff.data.changes} />
      </div>
    </div>
  );
}
