'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Rocket } from 'lucide-react';
import { SyncBadge, type SyncState } from '@/components/common/deploy-status';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { plural } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import { DeploymentRow } from './room-deployments';

const ATTENTION: SyncState[] = ['failed', 'drifted', 'unreachable'];

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border px-4 py-3">
      <div className={cn('tabular text-2xl font-semibold', value > 0 && tone)}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

/** Deploy state of every room at a glance, and the latest deployments across the organisation. */
export function DeploymentsView() {
  const trpc = useTRPC();
  const router = useRouter();
  const { orgId } = useOrg();
  const overview = useQuery({ ...trpc.deployment.overview.queryOptions({ orgId }), refetchInterval: 10_000 });
  const history = useQuery({ ...trpc.deployment.list.queryOptions({ orgId, limit: 30 }), refetchInterval: 10_000 });
  const [open, setOpen] = useState<string | null>(null);

  const rows = overview.data ?? [];
  const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
  const scheduled = rows.reduce((n, r) => n + r.scheduled.length, 0);

  return (
    <PageContainer>
      <PageHeader
        title="Deployments"
        description="What each room is running, what is on its way, and the history of every deployment."
      />
      {overview.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Rocket}
          title="No rooms yet"
          description="Create a room, design it and publish a release to deploy it."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="In sync" value={count((r) => r.state === 'in_sync')} />
            <Stat label="Deploying" value={count((r) => r.state === 'deploying')} />
            <Stat label="Need attention" value={count((r) => ATTENTION.includes(r.state))} tone="text-destructive" />
            <Stat label="Scheduled" value={scheduled} />
          </div>
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Room</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Running</TableHead>
                  <TableHead>Set to run</TableHead>
                  <TableHead>Pending</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const href = orgPath(orgId, `/rooms/${r.room.id}/deployments`);
                  return (
                    <TableRow key={r.room.id} className="cursor-pointer" onClick={() => router.push(href)}>
                      <TableCell className="font-medium">
                        <Link href={href} onClick={(e) => e.stopPropagation()} className="hover:underline">
                          {r.room.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <SyncBadge state={r.state} />
                      </TableCell>
                      <TableCell className="tabular">{r.reportedRelease ? `Release ${r.reportedRelease.number}` : '—'}</TableCell>
                      <TableCell className="tabular">{r.desiredRelease ? `Release ${r.desiredRelease.number}` : '—'}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {[
                          r.unpublishedChanges && 'Unpublished changes',
                          !r.unpublishedChanges && r.undeployedRelease && r.room.gatewayId && 'Newer release not deployed',
                          r.scheduled.length > 0 && `${plural(r.scheduled.length, 'scheduled deployment')}`,
                        ]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <section className="overflow-hidden rounded-lg border">
            <div className="border-b bg-muted/40 px-4 py-2.5">
              <h2 className="text-sm font-medium">Recent deployments</h2>
            </div>
            {history.isPending ? (
              <Skeleton className="m-4 h-12" />
            ) : history.data?.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted-foreground">Nothing has been deployed yet.</p>
            ) : (
              <ul className="divide-y">
                {(history.data ?? []).map((d) => (
                  <DeploymentRow
                    key={d.id}
                    d={d}
                    roomId={d.roomId}
                    showRoom
                    open={open === d.id}
                    onToggle={() => setOpen(open === d.id ? null : d.id)}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </PageContainer>
  );
}
