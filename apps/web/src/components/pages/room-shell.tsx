'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { DoorOpen, MoreHorizontal, PencilRuler, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { NavTabs } from '@/components/common/nav-tabs';
import { PageHeader } from '@/components/common/page-header';
import { HealthBadge } from '@/components/common/status';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { ROOM_TYPE_LABEL } from '@/lib/format';
import { useInvalidateEstate, useRoomsOverview } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';

export function useRoom(roomId: string) {
  const rooms = useRoomsOverview();
  return { room: rooms.data?.find((r) => r.id === roomId), isPending: rooms.isPending };
}

export function RoomShell({ roomId, children }: { roomId: string; children: React.ReactNode }) {
  const trpc = useTRPC();
  const router = useRouter();
  const { orgId, canEdit } = useOrg();
  const { room, isPending } = useRoom(roomId);
  const invalidate = useInvalidateEstate();
  const [deleting, setDeleting] = useState(false);

  const del = useMutation(
    trpc.room.delete.mutationOptions({
      onSuccess: async () => {
        await invalidate();
        toast.success('Room deleted');
        router.replace(orgPath(orgId, '/rooms'));
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (isPending)
    return (
      <div className="space-y-4 px-4 pt-6 sm:px-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-9 w-full" />
      </div>
    );

  if (!room)
    return (
      <div className="px-4 pt-6 sm:px-6">
        <EmptyState
          icon={DoorOpen}
          title="Room not found"
          description="It may have been deleted, or you might not have access."
          action={
            <Link
              href={orgPath(orgId, '/rooms')}
              className={buttonVariants({ variant: 'outline' })}
            >
              Back to rooms
            </Link>
          }
        />
      </div>
    );

  const base = orgPath(orgId, `/rooms/${roomId}`);
  return (
    <>
      <div className="space-y-4 px-4 pt-6 sm:px-6">
        <PageHeader
          title={room.name}
          meta={
            <>
              <span className="text-sm text-muted-foreground">{ROOM_TYPE_LABEL[room.type]}</span>
              <span aria-hidden className="text-muted-foreground/50">
                ·
              </span>
              <Link
                href={orgPath(orgId, `/sites/${room.siteId}`)}
                className="text-sm text-muted-foreground hover:text-foreground hover:underline"
              >
                {room.site.name}
              </Link>
              <span aria-hidden className="text-muted-foreground/50">
                ·
              </span>
              <HealthBadge draft={room.draft} />
            </>
          }
          actions={
            <>
              <Link href={`${base}/design`} className={buttonVariants({ size: 'sm' })}>
                <PencilRuler data-icon="inline-start" />
                {canEdit ? 'Open designer' : 'View design'}
              </Link>
              {canEdit && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="outline" size="icon-sm" aria-label="Room actions" />}
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => router.push(`${base}/settings`)}>
                      Rename or move
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                      <Trash2 className="size-4" /> Delete room
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </>
          }
        />
        <NavTabs
          tabs={[
            { label: 'Overview', href: base, exact: true },
            { label: 'Design', href: `${base}/design` },
            { label: 'Devices', href: `${base}/devices` },
            { label: 'Deployments', href: `${base}/deployments`, soon: true },
            { label: 'Monitoring', href: `${base}/monitoring`, soon: true },
            ...(canEdit ? [{ label: 'Settings', href: `${base}/settings` }] : []),
          ]}
        />
      </div>
      {children}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        destructive
        title={`Delete “${room.name}”?`}
        description="The room and its design, versions and history will be permanently removed."
        confirmLabel="Delete room"
        onConfirm={() => del.mutate({ orgId, roomId })}
      />
    </>
  );
}
