'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { DoorOpen, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { useDialogs, timezoneOptions } from '@/components/shell/dialogs';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { plural } from '@/lib/format';
import { useEstate, useInvalidateEstate } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';
import { SiteNetwork } from './network-health';
import { AreasPanel, SiteGateways, SiteRooms } from './site-areas';

export function SiteDetailView({ siteId }: { siteId: string }) {
  const trpc = useTRPC();
  const router = useRouter();
  const { orgId, canEdit } = useOrg();
  const { openNewRoom } = useDialogs();
  const { sites, roomsBySite, isPending } = useEstate();
  const invalidate = useInvalidateEstate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const site = sites.find((s) => s.id === siteId);
  const rooms = roomsBySite.get(siteId) ?? [];

  const del = useMutation(
    trpc.site.delete.mutationOptions({
      onSuccess: async () => {
        await invalidate();
        toast.success('Site deleted');
        router.replace(orgPath(orgId, '/sites'));
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (isPending)
    return (
      <PageContainer>
        <Skeleton className="h-16 w-72" />
        <Skeleton className="h-40 w-full" />
      </PageContainer>
    );
  if (!site)
    return (
      <PageContainer>
        <EmptyState
          icon={DoorOpen}
          title="Site not found"
          description="It may have been deleted, or you might not have access."
        />
      </PageContainer>
    );

  return (
    <PageContainer>
      <PageHeader
        title={site.name}
        description={`${site.timezone.replace(/_/g, ' ')} · ${plural(rooms.length, 'room')}`}
        actions={
          canEdit && (
            <>
              <Button size="sm" onClick={() => openNewRoom(site.id)}>
                <Plus data-icon="inline-start" /> New room
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button variant="outline" size="icon-sm" aria-label="Site actions" />}
                >
                  <MoreHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setEditing(true)}>
                    <Pencil className="size-4" /> Edit site
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                    <Trash2 className="size-4" /> Delete site
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )
        }
      />

      <AreasPanel siteId={site.id} />

      <SiteNetwork siteId={site.id} />

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Rooms</h2>
        {rooms.length === 0 ? (
          <EmptyState
            icon={DoorOpen}
            title="No rooms in this site"
            description="Add a room, then put its devices in it."
            action={
              canEdit ? <Button onClick={() => openNewRoom(site.id)}>Add a room</Button> : undefined
            }
          />
        ) : (
          <SiteRooms siteId={site.id} />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Gateways</h2>
        <SiteGateways siteId={site.id} />
      </section>

      <EditSiteDialog open={editing} onOpenChange={setEditing} site={site} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        destructive
        title={`Delete “${site.name}”?`}
        description={
          rooms.length > 0
            ? 'This site still has rooms. Move or delete them first.'
            : 'This can’t be undone.'
        }
        confirmLabel="Delete site"
        onConfirm={() => del.mutate({ orgId, siteId })}
      />
    </PageContainer>
  );
}

function EditSiteDialog({
  open,
  onOpenChange,
  site,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  site: { id: string; name: string; timezone: string };
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const invalidate = useInvalidateEstate();
  const [name, setName] = useState(site.name);
  const [timezone, setTimezone] = useState(site.timezone);
  const update = useMutation(
    trpc.site.update.mutationOptions({
      onSuccess: async () => {
        await invalidate();
        toast.success('Site updated');
        onOpenChange(false);
      },
    }),
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setName(site.name);
          setTimezone(site.timezone);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ orgId, siteId: site.id, name, timezone });
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit site</DialogTitle>
            <DialogDescription>Rename the site or change its timezone.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="edit-site-name">Name</Label>
            <Input
              id="edit-site-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-site-tz">Timezone</Label>
            <SimpleSelect
              id="edit-site-tz"
              className="w-full"
              value={timezone}
              onValueChange={setTimezone}
              options={timezoneOptions()}
            />
          </div>
          {update.error && <p className="text-sm text-destructive">{update.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending || !name.trim()}>
              {update.isPending && <Spinner />}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
