'use client';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, GitCompare } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { timeAgo } from '@/lib/format';
import { useTRPC } from '@/trpc/client';

/** Every monitored device: what it is held to, whether it has drifted, and its baseline snapshot. */
export function ConfigDriftView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport } = useOrg();
  const overview = useQuery({
    ...trpc.config.overview.queryOptions({ orgId }),
    refetchInterval: 30_000,
  });
  const snap = useMutation(
    trpc.config.takeSnapshot.mutationOptions({
      onSuccess: async () => {
        toast.success('Snapshot taken and set as the baseline');
        await qc.invalidateQueries({ queryKey: trpc.config.overview.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const rows = overview.data ?? [];
  const drifted = rows.filter((r) => r.drift.length > 0);
  return (
    <PageContainer>
      <PageHeader
        title="Snapshots and drift"
        description="Devices held to a profile or to settings of their own, and any that no longer match. A baseline snapshot lets you see everything that has changed since."
      />
      {overview.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : overview.isError ? (
        <p className="text-sm text-destructive">{overview.error.message}</p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={GitCompare}
          title="No monitored devices"
          description="Add networked devices with a driver, then hold them to a profile."
        />
      ) : (
        <>
          <p className="text-sm">
            <span className="font-semibold">{drifted.length}</span> of {rows.length} monitored
            devices have drifted.
          </p>
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Device</TableHead>
                  <TableHead>Held to</TableHead>
                  <TableHead>Drift</TableHead>
                  <TableHead>Baseline</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">
                      <Link href={orgPath(orgId, `/devices/${r.id}`)} className="hover:underline">
                        {r.name}
                      </Link>
                      {r.roomName && (
                        <div className="text-xs font-normal text-muted-foreground">
                          {r.roomName}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.profileName ??
                        (r.held ? (
                          'Its own settings'
                        ) : (
                          <span className="text-muted-foreground">Nothing</span>
                        ))}
                    </TableCell>
                    <TableCell>
                      {r.drift.length === 0 ? (
                        <span className="text-sm text-muted-foreground">
                          {r.held ? 'Matches' : '–'}
                        </span>
                      ) : (
                        <div className="space-y-1">
                          {r.drift.map((d) => (
                            <div key={d.field} className="text-xs">
                              <Badge variant="destructive" className="mr-1.5">
                                {d.label}
                              </Badge>
                              reads {d.actual}, should be {d.desired}
                              <span className="text-muted-foreground"> · {timeAgo(d.since)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {r.baselineAt ? timeAgo(r.baselineAt) : 'None'}
                    </TableCell>
                    <TableCell className="text-right">
                      {canSupport && (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={snap.isPending}
                          onClick={() => snap.mutate({ orgId, deviceId: r.id, baseline: true })}
                        >
                          <Camera data-icon="inline-start" /> Set baseline
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </PageContainer>
  );
}
