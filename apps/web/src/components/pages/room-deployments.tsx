'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { AnimatedCollapse } from '@/components/common/animated-collapse';
import {
  DiffView,
  STATUS_LABEL,
  StageTimeline,
  StatusPill,
  SyncBadge,
  SYNC_HELP,
} from '@/components/common/deploy-status';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';
import { DeployDialog, PublishDialog } from './deploy-dialogs';
import { useRoom } from './room-shell';

type Deployment = RouterOutputs['deployment']['list'][number];

const when = (d: Date | string) =>
  new Date(d).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-4 py-2.5">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Releases, what is running, scheduled deployments and the history of every attempt. */
export function RoomDeployments({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canEdit } = useOrg();
  const { room } = useRoom(roomId);
  const status = useQuery({
    ...trpc.deployment.roomStatus.queryOptions({ orgId, roomId }),
    refetchInterval: (q) => (q.state.data?.state === 'deploying' ? 3_000 : 15_000),
  });
  const releases = useQuery({ ...trpc.release.list.queryOptions({ orgId, roomId }), refetchInterval: 15_000 });
  const history = useQuery({
    ...trpc.deployment.list.queryOptions({ orgId, roomId }),
    refetchInterval: status.data?.state === 'deploying' ? 3_000 : 15_000,
  });
  const [publishing, setPublishing] = useState(false);
  const [deploying, setDeploying] = useState<{ id: string; number: number } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const cancel = useMutation(
    trpc.deployment.cancel.mutationOptions({
      onSuccess: async () => {
        await Promise.all([
          qc.invalidateQueries({ queryKey: trpc.deployment.list.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.deployment.roomStatus.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.deployment.overview.queryKey() }),
        ]);
        toast.success('Scheduled deployment cancelled');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (!room) return null;
  const s = status.data;
  const list = releases.data?.releases ?? [];
  const hasGateway = !!room.gateway;
  const running = s?.desiredRelease ?? null;
  const shown = showAll ? list : list.slice(0, 6);
  const settingsHref = orgPath(orgId, `/rooms/${roomId}/settings`);

  return (
    <PageContainer className="max-w-4xl pt-5">
      <Section
        title="Status"
        action={
          canEdit && (
            <Button size="sm" disabled={!room.draft} onClick={() => setPublishing(true)}>
              <Rocket data-icon="inline-start" />
              Publish
            </Button>
          )
        }
      >
        <div className="space-y-3 px-4 py-4 text-sm">
          {!s ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SyncBadge state={s.state} />
                <span className="text-muted-foreground">
                  {hasGateway ? `Gateway: ${room.gateway!.name}` : 'No gateway assigned'}
                </span>
              </div>
              <p className="text-muted-foreground">{SYNC_HELP[s.state]}</p>
              {!hasGateway && (
                <p>
                  <Link href={settingsHref} className="underline-offset-4 hover:underline">
                    Choose a gateway in settings
                  </Link>{' '}
                  to deploy this room.
                </p>
              )}
              {s.state === 'failed' && s.deployment?.error && <p className="text-destructive">{s.deployment.error}</p>}
              {s.reportedRelease && (
                <p className="text-muted-foreground">
                  Gateway is running release <span className="tabular">{s.reportedRelease.number}</span>
                  {running && running.id !== s.reportedRelease.id && (
                    <>
                      ; this room is set to run release <span className="tabular">{running.number}</span>
                    </>
                  )}
                  .
                </p>
              )}
              {s.unpublishedChanges && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-warning/10 px-3 py-2">
                  <span>
                    The design has changed since{' '}
                    {s.latestRelease ? `release ${s.latestRelease.number}` : 'it was last saved'}.
                  </span>
                  {canEdit && (
                    <Button variant="outline" size="xs" onClick={() => setPublishing(true)}>
                      Review and publish
                    </Button>
                  )}
                </div>
              )}
              {!s.unpublishedChanges && s.undeployedRelease && s.latestRelease && hasGateway && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted px-3 py-2">
                  <span>Release {s.latestRelease.number} is published but not deployed.</span>
                  {canEdit && (
                    <Button variant="outline" size="xs" onClick={() => setDeploying(s.latestRelease)}>
                      Deploy it
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </Section>

      {s && s.scheduled.length > 0 && (
        <Section title="Scheduled">
          <ul className="divide-y">
            {s.scheduled.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span>
                  Release <span className="tabular font-medium">{d.releaseNumber}</span> at {when(d.scheduledFor)}
                </span>
                {canEdit && (
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={cancel.isPending}
                    onClick={() => cancel.mutate({ orgId, deploymentId: d.id })}
                  >
                    Cancel
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Releases">
        {releases.isPending ? (
          <Skeleton className="m-4 h-12" />
        ) : list.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            Publishing freezes the current design as a signed release. You can then deploy it, or roll back to it later.
          </p>
        ) : (
          <ul className="divide-y">
            {shown.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="tabular font-medium">Release {r.number}</span>
                  {r.id === s?.desiredRelease?.id && <Badge variant="secondary">To run</Badge>}
                  {r.id === s?.reportedRelease?.id && <Badge>Running</Badge>}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="text-xs text-muted-foreground">{timeAgo(r.createdAt)}</span>
                  {canEdit && hasGateway && !(r.id === s?.desiredRelease?.id && s.state === 'in_sync') && (
                    <Button variant="outline" size="xs" onClick={() => setDeploying({ id: r.id, number: r.number })}>
                      {running && r.number < running.number ? 'Roll back' : 'Deploy'}
                    </Button>
                  )}
                </span>
              </li>
            ))}
            {list.length > 6 && (
              <li className="px-4 py-2">
                <Button variant="ghost" size="xs" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? 'Show fewer' : `Show all ${list.length}`}
                </Button>
              </li>
            )}
          </ul>
        )}
      </Section>

      <Section title="History">
        {history.isPending ? (
          <Skeleton className="m-4 h-12" />
        ) : history.data?.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={Rocket} title="No deployments yet" description="Deployments you start will show here, step by step." className="py-8" />
          </div>
        ) : (
          <ul className="divide-y">
            {(history.data ?? []).map((d) => (
              <DeploymentRow
                key={d.id}
                d={d}
                roomId={roomId}
                open={open === d.id}
                onToggle={() => setOpen(open === d.id ? null : d.id)}
              />
            ))}
          </ul>
        )}
      </Section>

      <PublishDialog roomId={roomId} hasGateway={hasGateway} open={publishing} onOpenChange={setPublishing} />
      {deploying && (
        <DeployDialog
          roomId={roomId}
          release={deploying}
          running={running}
          open
          onOpenChange={(o) => !o && setDeploying(null)}
        />
      )}
    </PageContainer>
  );
}

export function DeploymentRow({
  d,
  roomId,
  open,
  onToggle,
  showRoom,
}: {
  d: Deployment;
  roomId: string;
  open: boolean;
  onToggle: () => void;
  showRoom?: boolean;
}) {
  const verb = d.kind === 'rollback' ? 'Rollback to' : 'Deploy';
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-muted/40"
      >
        <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 truncate">
          {showRoom && <span className="font-medium">{d.room.name} · </span>}
          {verb} release <span className="tabular font-medium">{d.release.number}</span>
          {d.status === 'scheduled' && d.scheduledFor && (
            <span className="text-muted-foreground"> · at {when(d.scheduledFor)}</span>
          )}
        </span>
        <StatusPill status={d.status} />
        <span className="hidden w-28 shrink-0 text-right text-xs text-muted-foreground sm:block">
          {timeAgo(d.createdAt)}
        </span>
      </button>
      <AnimatedCollapse open={open}>
        <div className="grid gap-6 border-t bg-muted/20 px-4 py-4 sm:grid-cols-2">
          <div className="space-y-3">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Progress</h3>
            {d.status === 'scheduled' || d.status === 'cancelled' || d.status === 'superseded' ? (
              <p className="text-sm text-muted-foreground">
                {d.status === 'scheduled' && 'Waiting for its scheduled time.'}
                {d.status === 'cancelled' && 'Cancelled before it started.'}
                {d.status === 'superseded' && 'Replaced by a newer deployment before it finished.'}
              </p>
            ) : (
              <StageTimeline status={d.status} events={d.events} error={d.error} />
            )}
            <p className="text-xs text-muted-foreground">
              {STATUS_LABEL[d.status] ?? d.status} · started by {d.createdByEmail ?? 'the system'} ·{' '}
              {when(d.createdAt)}
            </p>
          </div>
          <div className="space-y-3">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">What changed</h3>
            {open && <DiffView roomId={roomId} toReleaseId={d.releaseId} />}
          </div>
        </div>
      </AnimatedCollapse>
    </li>
  );
}
