'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { GatewayStatus } from '@/components/common/status';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { timeAgo } from '@/lib/format';
import { useInvalidateEstate } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';
import { useRoom } from './room-shell';

/** Publish releases, roll back, and see what the gateway says it is actually running. */
export function ReleasePanel({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canEdit } = useOrg();
  const { room } = useRoom(roomId);
  const invalidate = useInvalidateEstate();
  const [showAll, setShowAll] = useState(false);
  const data = useQuery({
    ...trpc.release.list.queryOptions({ orgId, roomId }),
    refetchInterval: 10_000,
  });

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: trpc.release.list.queryKey() }),
      invalidate(),
    ]);
  };
  const publish = useMutation(
    trpc.release.publish.mutationOptions({
      onSuccess: async (r) => {
        await refresh();
        toast.success(`Release ${r.number} published`);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const deploy = useMutation(
    trpc.release.deploy.mutationOptions({
      onSuccess: async (r) => {
        await refresh();
        toast.success(`Release ${r.number} is now the one to run`);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (!room) return null;
  const releases = data.data?.releases ?? [];
  const desired = data.data?.desiredReleaseId ?? null;
  const reported = data.data?.reportedReleaseId ?? null;
  const number = (id: string | null) => releases.find((r) => r.id === id)?.number;
  const settingsHref = orgPath(orgId, `/rooms/${roomId}/settings`);

  let status: React.ReactNode;
  if (!room.gateway)
    status = (
      <span className="text-muted-foreground">
        No gateway assigned.{' '}
        <Link href={settingsHref} className="text-foreground underline-offset-4 hover:underline">
          Choose one in settings
        </Link>
        .
      </span>
    );
  else if (!desired) status = <span className="text-muted-foreground">Nothing published yet.</span>;
  else if (data.data?.reportedError)
    status = <span className="text-destructive">{data.data.reportedError}</span>;
  else if (reported === desired)
    status = (
      <span>
        Running release {number(desired) ?? '?'}
        {data.data?.reportedStatus ? ` (${data.data.reportedStatus})` : ''}
      </span>
    );
  else if (room.gateway.status === 'online')
    status = <span className="text-muted-foreground">Sending release {number(desired) ?? '?'} to the gateway…</span>;
  else
    status = (
      <span className="text-muted-foreground">
        Release {number(desired) ?? '?'} will start when the gateway is online.
      </span>
    );

  const shown = showAll ? releases : releases.slice(0, 4);
  return (
    <section className="overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2.5">
        <h2 className="text-sm font-medium">Releases</h2>
        {canEdit && (
          <Button
            size="sm"
            disabled={publish.isPending || !room.draft}
            title={room.draft ? '' : 'Design the room first'}
            onClick={() => publish.mutate({ orgId, roomId })}
          >
            {publish.isPending ? <Spinner /> : <Rocket data-icon="inline-start" />}
            Publish
          </Button>
        )}
      </div>
      <div className="space-y-3 px-4 py-4 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Gateway</span>
          <GatewayStatus gateway={room.gateway} />
        </div>
        <div>{status}</div>
        {data.data?.reportedAt && (
          <div className="text-xs text-muted-foreground">Reported {timeAgo(data.data.reportedAt)}</div>
        )}
      </div>
      {data.isPending ? (
        <Skeleton className="m-4 h-12" />
      ) : releases.length === 0 ? (
        <p className="border-t px-4 py-4 text-xs text-muted-foreground">
          Publishing freezes the current design as a signed release and sends it to the gateway.
        </p>
      ) : (
        <ul className="divide-y border-t">
          {shown.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span className="tabular font-medium">Release {r.number}</span>
                {r.id === desired && <Badge variant="secondary">To run</Badge>}
                {r.id === reported && <Badge>Running</Badge>}
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <span className="text-xs text-muted-foreground">{timeAgo(r.createdAt)}</span>
                {canEdit && r.id !== desired && (
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={deploy.isPending}
                    onClick={() => deploy.mutate({ orgId, roomId, releaseId: r.id })}
                  >
                    {desired && (number(desired) ?? 0) > r.number ? 'Roll back to this' : 'Deploy'}
                  </Button>
                )}
              </span>
            </li>
          ))}
          {releases.length > 4 && (
            <li className="px-4 py-2">
              <Button variant="ghost" size="xs" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show fewer' : `Show all ${releases.length}`}
              </Button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
