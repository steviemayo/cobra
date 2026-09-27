'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useInvalidateEstate, useRoomsOverview } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';
import { useRoom } from './room-shell';

/**
 * Trying changes without touching a live room. A live room can make a staging copy (free, and it
 * raises no alerts); a staging room can send its design back into a live room, to review and publish.
 */
export function StagingCard({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const { orgId } = useOrg();
  const { room } = useRoom(roomId);
  const rooms = useRoomsOverview();
  const invalidate = useInvalidateEstate();
  const [target, setTarget] = useState('');
  const [confirming, setConfirming] = useState(false);

  const make = useMutation(
    trpc.room.duplicate.mutationOptions({
      onSuccess: async (copy) => {
        await invalidate();
        toast.success(`Created “${copy.name}”. Set its device addresses, then publish it to the gateway.`);
        router.push(orgPath(orgId, `/rooms/${copy.id}/devices`));
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const promote = useMutation(
    trpc.room.promoteStaging.mutationOptions({
      onSuccess: async (res) => {
        await Promise.all([invalidate(), qc.invalidateQueries({ queryKey: trpc.draft.get.queryKey() })]);
        toast.success(
          res.changed
            ? 'The design is in the live room’s draft. Review it there, then publish. Its earlier design is kept in its saved versions.'
            : 'The live room already has this design.',
        );
        setConfirming(false);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (!room || room.kind === 'combined') return null;

  if (room.kind !== 'staging')
    return (
      <section className="space-y-3 rounded-lg border p-4">
        <div>
          <h2 className="text-sm font-medium">Staging copy</h2>
          <p className="text-sm text-muted-foreground">
            Try changes on a copy of this room first. A staging copy is free, raises no alerts and stays out of usage reports.
            Give it its own device addresses, or test it while this room is idle, since two rooms cannot use one device at once.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={make.isPending}
          onClick={() => make.mutate({ orgId, roomId, name: `${room.name} (staging)`, staging: true })}
        >
          {make.isPending && <Spinner />}
          Create staging copy
        </Button>
      </section>
    );

  const options = (rooms.data ?? [])
    .filter((r) => r.siteId === room.siteId && r.type === room.type && r.kind === 'standard')
    .map((r) => ({ value: r.id, label: r.name }));
  const targetName = options.find((o) => o.value === target)?.label;
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div>
        <h2 className="text-sm font-medium">Promote to a live room</h2>
        <p className="text-sm text-muted-foreground">
          Sends this design into a live room’s draft. Nothing is published or deployed, so you review it there first, and
          the live room’s current design is kept as a saved version. Device addresses are not copied.
        </p>
      </div>
      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">There is no live room of this type at this site to promote into.</p>
      ) : (
        <div className="flex gap-2">
          <SimpleSelect className="w-64" value={target} onValueChange={setTarget} options={options} placeholder="Choose a live room" />
          <Button variant="outline" size="sm" disabled={!target || promote.isPending} onClick={() => setConfirming(true)}>
            {promote.isPending && <Spinner />}
            Promote
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Promote into “${targetName ?? ''}”?`}
        description="Replaces the working design of that room with this one. Nothing is published or deployed, and its current design is kept in its saved versions."
        confirmLabel="Promote design"
        onConfirm={() => promote.mutate({ orgId, roomId, targetRoomId: target })}
      />
    </section>
  );
}
