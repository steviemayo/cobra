'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Rocket } from 'lucide-react';
import { SyncBadge, SYNC_HELP } from '@/components/common/deploy-status';
import { GatewayStatus } from '@/components/common/status';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { timeAgo } from '@/lib/format';
import { useTRPC } from '@/trpc/client';
import { PublishDialog } from './deploy-dialogs';
import { useRoom } from './room-shell';

/** A short summary of what this room is running, with the way in to the full Deployments tab. */
export function ReleasePanel({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const { orgId, canEdit } = useOrg();
  const { room } = useRoom(roomId);
  const [publishing, setPublishing] = useState(false);
  const status = useQuery({
    ...trpc.deployment.roomStatus.queryOptions({ orgId, roomId }),
    refetchInterval: (q) => (q.state.data?.state === 'deploying' ? 3_000 : 15_000),
  });
  if (!room) return null;
  const s = status.data;
  const deployments = orgPath(orgId, `/rooms/${roomId}/deployments`);

  return (
    <section className="overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2.5">
        <h2 className="text-sm font-medium">Deployment</h2>
        {canEdit && (
          <Button size="sm" disabled={!room.draft} title={room.draft ? '' : 'Design the room first'} onClick={() => setPublishing(true)}>
            <Rocket data-icon="inline-start" />
            Publish
          </Button>
        )}
      </div>
      <div className="space-y-3 px-4 py-4 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Gateway</span>
          <GatewayStatus gateway={room.gateway} />
        </div>
        {!s ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">State</span>
              <SyncBadge state={s.state} />
            </div>
            <p className="text-muted-foreground">
              {s.reportedRelease && s.state === 'in_sync'
                ? `Running release ${s.reportedRelease.number}.`
                : SYNC_HELP[s.state]}
            </p>
            {s.unpublishedChanges && <p className="text-warning">The design has unpublished changes.</p>}
            {s.deployment?.error && s.state === 'failed' && <p className="text-destructive">{s.deployment.error}</p>}
            {room.gateway && s.deployment && (
              <p className="text-xs text-muted-foreground">
                Last deployment {timeAgo(s.deployment.finishedAt ?? s.deployment.createdAt)}
              </p>
            )}
          </>
        )}
        <Link href={deployments} className="inline-block text-sm underline-offset-4 hover:underline">
          Releases and history
        </Link>
      </div>
      <PublishDialog roomId={roomId} hasGateway={!!room.gateway} open={publishing} onOpenChange={setPublishing} />
    </section>
  );
}
