'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { PageContainer } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { ROOM_TYPE_LABEL } from '@/lib/format';
import { useInvalidateEstate, useSites } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';
import { GatewaySetting, HookSettings, PanelSettings } from './room-deploy-settings';
import { useRoom } from './room-shell';

export function RoomSettings({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const router = useRouter();
  const { orgId, canEdit } = useOrg();
  const { room } = useRoom(roomId);
  const sites = useSites();
  const invalidate = useInvalidateEstate();
  const [name, setName] = useState<string | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [copyName, setCopyName] = useState<string | null>(null);

  const update = useMutation(
    trpc.room.update.mutationOptions({
      onSuccess: async () => {
        await invalidate();
        toast.success('Room updated');
        setName(null);
        setSiteId(null);
      },
    }),
  );
  const duplicate = useMutation(
    trpc.room.duplicate.mutationOptions({
      onSuccess: async (copy) => {
        await invalidate();
        toast.success(`Created “${copy.name}”. Fill in its device addresses next.`);
        router.push(orgPath(orgId, `/rooms/${copy.id}/devices`));
      },
      onError: (e) => toast.error(e.message),
    }),
  );
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

  if (!room) return null;
  if (!canEdit)
    return (
      <PageContainer className="pt-5">
        <p className="text-sm text-muted-foreground">
          You don’t have permission to change this room.
        </p>
      </PageContainer>
    );

  const nameValue = name ?? room.name;
  const copyNameValue = copyName ?? `${room.name} copy`;
  const siteValue = siteId ?? room.siteId;
  const dirty = nameValue.trim() !== room.name || siteValue !== room.siteId;

  return (
    <PageContainer className="max-w-2xl pt-5">
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate({
            orgId,
            roomId,
            name: nameValue.trim() !== room.name ? nameValue : undefined,
            siteId: siteValue !== room.siteId ? siteValue : undefined,
          });
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="room-name">Name</Label>
          <Input
            id="room-name"
            required
            value={nameValue}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="room-site">Site</Label>
          <SimpleSelect
            id="room-site"
            className="w-full"
            value={siteValue}
            onValueChange={setSiteId}
            options={(sites.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
          />
        </div>
        <div className="space-y-2">
          <Label>Room type</Label>
          <p className="text-sm text-muted-foreground">
            {ROOM_TYPE_LABEL[room.type]}. The type is fixed once a room is created.
          </p>
        </div>
        {update.error && <p className="text-sm text-destructive">{update.error.message}</p>}
        <Button type="submit" disabled={!dirty || update.isPending || !nameValue.trim()}>
          {update.isPending && <Spinner />}
          Save changes
        </Button>
      </form>

      <GatewaySetting roomId={roomId} />
      <PanelSettings roomId={roomId} />
      <HookSettings roomId={roomId} />

      {room.kind !== 'combined' && (
        <form
          className="space-y-3 rounded-lg border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            duplicate.mutate({ orgId, roomId, name: copyNameValue.trim() });
          }}
        >
          <div>
            <h2 className="text-sm font-medium">Duplicate room</h2>
            <p className="text-sm text-muted-foreground">
              Makes a new room at this site with the same design and gateway. Each device in the new room
              needs its own address, so those are left to fill in.
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              aria-label="Name of the new room"
              required
              value={copyNameValue}
              onChange={(e) => setCopyName(e.target.value)}
            />
            <Button type="submit" variant="outline" disabled={duplicate.isPending || !copyNameValue.trim()}>
              {duplicate.isPending && <Spinner />}
              Duplicate
            </Button>
          </div>
        </form>
      )}

      <section className="space-y-3 rounded-lg border border-destructive/30 p-4">
        <div>
          <h2 className="text-sm font-medium text-destructive">Delete room</h2>
          <p className="text-sm text-muted-foreground">
            Permanently removes this room with its design and saved versions.
          </p>
        </div>
        <Button variant="destructive" size="sm" onClick={() => setDeleting(true)}>
          Delete room
        </Button>
      </section>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        destructive
        title={`Delete “${room.name}”?`}
        description="This can’t be undone."
        confirmLabel="Delete room"
        onConfirm={() => del.mutate({ orgId, roomId })}
      />
    </PageContainer>
  );
}
