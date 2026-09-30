'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { DoorOpen, LifeBuoy, SlidersHorizontal } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { plural } from '@/lib/format';
import { useRoomsOverview } from '@/lib/use-estate';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';

type Room = NonNullable<ReturnType<typeof useRoomsOverview>['data']>[number];

// Plain words for a customer: no device or gateway jargon.
function state(room: Room): { label: string; tone: string } {
  if (!room.gateway || room.gateway.status !== 'online')
    return { label: 'Not connected', tone: 'bg-destructive' };
  switch (room.reportedStatus) {
    case 'on':
      return { label: 'In use', tone: 'bg-success' };
    case 'starting':
      return { label: 'Starting', tone: 'bg-warning' };
    case 'stopping':
      return { label: 'Turning off', tone: 'bg-warning' };
    case 'fault':
      return { label: 'Needs attention', tone: 'bg-destructive' };
    case 'off':
      return { label: 'Ready', tone: 'bg-muted-foreground/50' };
    default:
      return { label: 'Not set up yet', tone: 'bg-muted-foreground/35' };
  }
}

/** What a customer sees instead of the builder's overview: their rooms, control, and help. */
export function CustomerDashboard() {
  const trpc = useTRPC();
  const { orgId, org } = useOrg();
  const rooms = useRoomsOverview();
  const tickets = useQuery({
    ...trpc.ticket.list.queryOptions({ orgId, status: 'active' }),
    refetchInterval: 30_000,
  });
  const open = tickets.data?.length ?? 0;

  return (
    <PageContainer>
      <PageHeader
        title={org.name}
        description="Your rooms at a glance."
        actions={
          <Link
            href={orgPath(orgId, '/tickets')}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <LifeBuoy data-icon="inline-start" />
            {open > 0 ? `Support (${open} open)` : 'Get help'}
          </Link>
        }
      />
      {rooms.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : rooms.data?.length === 0 ? (
        <EmptyState
          icon={DoorOpen}
          title="No rooms yet"
          description="Your rooms will appear here once they’re set up."
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{plural(rooms.data?.length ?? 0, 'room')}</p>
          <ul className="divide-y overflow-hidden rounded-lg border">
            {rooms.data?.map((r) => {
              const s = state(r);
              return (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="font-medium">{r.name}</div>
                    <div className="text-sm text-muted-foreground">{r.site.name}</div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="inline-flex items-center gap-2 text-sm">
                      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', s.tone)} />
                      {s.label}
                    </span>
                    <Link
                      href={orgPath(orgId, `/rooms/${r.id}`)}
                      className={buttonVariants({ size: 'sm' })}
                    >
                      <SlidersHorizontal data-icon="inline-start" /> Control
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </PageContainer>
  );
}
