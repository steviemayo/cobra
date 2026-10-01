'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { INCIDENT_KIND_LABEL, SeverityPill, dateTime } from '@/components/common/health';
import { PageContainer } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/trpc/client';
import { RoomDeviceList } from './room-devices';

/** How one room is doing: its devices right now, and its incidents. */
export function RoomMonitoring({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const incidents = useQuery({
    ...trpc.monitoring.incidents.queryOptions({ orgId, status: 'all', limit: 100 }),
    refetchInterval: 15_000,
    retry: false,
  });
  const mine = (incidents.data ?? []).filter((i) => i.roomId === roomId);
  return (
    <PageContainer className="pt-5">
      <div className="space-y-6">
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Devices</h2>
          <RoomDeviceList roomId={roomId} />
        </section>
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Incidents</h2>
          {incidents.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : mine.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing has gone wrong in this room recently.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {mine.map((i) => (
                <li
                  key={i.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm"
                >
                  <span>
                    <Link
                      href={orgPath(orgId, '/incidents')}
                      className="font-medium hover:underline"
                    >
                      {i.title}
                    </Link>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {INCIDENT_KIND_LABEL[i.kind] ?? i.kind}
                    </span>
                  </span>
                  <span className="flex items-center gap-3 text-xs text-muted-foreground">
                    <SeverityPill severity={i.severity} />
                    {i.status === 'open' ? (
                      <Badge>Open</Badge>
                    ) : (
                      <Badge variant="secondary">Closed</Badge>
                    )}
                    {dateTime(i.openedAt, i.timezone)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </PageContainer>
  );
}
