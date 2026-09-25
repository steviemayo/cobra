'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { DoorOpen, Plus } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/trpc/client';

export function GroupsView() {
  const trpc = useTRPC();
  const { orgId, canEdit } = useOrg();
  const list = useQuery({
    ...trpc.roomGroup.list.queryOptions({ orgId }),
    refetchInterval: 15_000,
  });
  const base = `/o/${orgId}/groups`;

  return (
    <PageContainer>
      <PageHeader
        title="Room groups"
        description="Rooms that can be joined by opening movable walls. Kestrel makes a room for every combination the walls allow, so each one is controlled as a single space."
        actions={
          canEdit && (
            <Button size="sm" render={<Link href={`${base}/new`} />}>
              <Plus data-icon="inline-start" /> New group
            </Button>
          )
        }
      />
      {list.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : list.data?.length === 0 ? (
        <EmptyState
          icon={DoorOpen}
          title="No room groups"
          description="Add the rooms that share movable walls, and say which walls join which rooms. The rooms must be at one site and run on one gateway."
          action={
            canEdit ? <Button render={<Link href={`${base}/new`} />}>New group</Button> : undefined
          }
        />
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {list.data?.map((g) => (
            <li key={g.id}>
              <Link
                href={`${base}/${g.id}`}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-muted/50"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="font-medium">{g.name}</div>
                  <div className="text-sm text-muted-foreground">
                    {g.siteName} · {g.rooms.join(', ')}
                  </div>
                </div>
                <div className="text-right text-sm text-muted-foreground">
                  <div>
                    {g.dividerCount} {g.dividerCount === 1 ? 'wall' : 'walls'} · {g.combinedCount}{' '}
                    combined {g.combinedCount === 1 ? 'room' : 'rooms'}
                  </div>
                  <div className={g.createdCount < g.combinedCount ? 'text-warning' : undefined}>
                    {g.problems.length > 0
                      ? 'Needs attention'
                      : g.createdCount === g.combinedCount
                        ? 'All created'
                        : `${g.combinedCount - g.createdCount} to create`}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  );
}
