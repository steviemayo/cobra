'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Shapes, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/trpc/client';

/** The room shapes the organisation has saved, to make rooms from or delete. */
export function RoomShapes() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canEdit } = useOrg();
  const shapes = useQuery(trpc.room.shapes.queryOptions({ orgId }));
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const del = useMutation(
    trpc.room.deleteShape.mutationOptions({
      onSuccess: async () => {
        await qc.invalidateQueries({ queryKey: trpc.room.shapes.queryKey() });
        toast.success('Shape deleted');
        setDeleting(null);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <PageContainer>
      <PageHeader
        title="Room shapes"
        description="The devices a room is made of, kept without addresses or logins, to make many rooms from."
      />
      {shapes.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : !shapes.data?.length ? (
        <EmptyState
          icon={Shapes}
          title="No shapes yet"
          description="Open a room’s settings and choose “Save as a shape” to keep its devices and control points here."
        />
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {shapes.data.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="font-medium">{s.name}</div>
                <div className="text-sm text-muted-foreground">
                  {s.devices} device{s.devices === 1 ? '' : 's'}
                  {s.description ? ` · ${s.description}` : ''}
                </div>
              </div>
              {canEdit && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    render={<Link href={orgPath(orgId, `/rooms/shapes/${s.id}`)} />}
                  >
                    Make rooms
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${s.name}`}
                    onClick={() => setDeleting({ id: s.id, name: s.name })}
                  >
                    <Trash2 />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.name ?? ''}”?`}
        description="Rooms already made from it are not changed."
        confirmLabel="Delete shape"
        onConfirm={() => deleting && del.mutate({ orgId, shapeId: deleting.id })}
      />
    </PageContainer>
  );
}
