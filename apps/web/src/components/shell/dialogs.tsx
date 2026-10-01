'use client';
import { createContext, useContext, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SimpleSelect } from '@/components/common/simple-select';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { useInvalidateEstate, useSites } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';
import { orgPath, useOrg } from './org-context';

interface DialogsApi {
  openNewSite: () => void;
  openNewRoom: (siteId?: string) => void;
}

const DialogsContext = createContext<DialogsApi | null>(null);

export function useDialogs(): DialogsApi {
  const ctx = useContext(DialogsContext);
  if (!ctx) throw new Error('useDialogs must be used inside DialogsProvider');
  return ctx;
}

export function DialogsProvider({ children }: { children: React.ReactNode }) {
  const [siteOpen, setSiteOpen] = useState(false);
  const [room, setRoom] = useState<{ open: boolean; siteId?: string }>({ open: false });
  const api = useMemo<DialogsApi>(
    () => ({
      openNewSite: () => setSiteOpen(true),
      openNewRoom: (siteId) => setRoom({ open: true, siteId }),
    }),
    [],
  );
  return (
    <DialogsContext.Provider value={api}>
      {children}
      <NewSiteDialog open={siteOpen} onOpenChange={setSiteOpen} />
      <NewRoomDialog
        open={room.open}
        siteId={room.siteId}
        onOpenChange={(open) => setRoom((r) => ({ ...r, open }))}
        onNeedSite={() => {
          setRoom({ open: false });
          setSiteOpen(true);
        }}
      />
    </DialogsContext.Provider>
  );
}

const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function timezoneOptions() {
  const zones = Intl.supportedValuesOf('timeZone');
  return zones.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }));
}

function NewSiteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const { orgId } = useOrg();
  const invalidate = useInvalidateEstate();
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(browserTimezone());
  const create = useMutation(
    trpc.site.create.mutationOptions({
      onSuccess: async (site) => {
        await invalidate();
        toast.success(`Site “${site.name}” created`);
        onOpenChange(false);
        setName('');
        router.push(orgPath(orgId, `/sites/${site.id}`));
      },
    }),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ orgId, name, timezone });
          }}
          className="space-y-5"
        >
          <DialogHeader>
            <DialogTitle>New site</DialogTitle>
            <DialogDescription>
              A site is a physical location, such as a building or campus, that contains rooms.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="site-name">Name</Label>
            <Input
              id="site-name"
              autoFocus
              required
              placeholder="Sydney HQ"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="site-tz">Timezone</Label>
            <SimpleSelect
              id="site-tz"
              className="w-full"
              value={timezone}
              onValueChange={setTimezone}
              options={timezoneOptions()}
            />
            <p className="text-xs text-muted-foreground">
              Used for schedules in this site’s rooms.
            </p>
          </div>
          {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending && <Spinner />}
              Create site
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewRoomDialog({
  open,
  siteId: presetSiteId,
  onOpenChange,
  onNeedSite,
}: {
  open: boolean;
  siteId?: string;
  onOpenChange: (open: boolean) => void;
  onNeedSite: () => void;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const { orgId } = useOrg();
  const sites = useSites();
  const invalidate = useInvalidateEstate();
  const [name, setName] = useState('');
  const [pickedSite, setPickedSite] = useState('');
  const siteList = sites.data ?? [];
  const siteId = pickedSite || presetSiteId || siteList[0]?.id || '';

  const create = useMutation(
    trpc.room.create.mutationOptions({
      onSuccess: async (room) => {
        await invalidate();
        toast.success(`Room “${room.name}” created`);
        onOpenChange(false);
        setName('');
        setPickedSite('');
        router.push(orgPath(orgId, `/rooms/${room.id}/devices`));
      },
    }),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {sites.isSuccess && siteList.length === 0 ? (
          <div className="space-y-5">
            <DialogHeader>
              <DialogTitle>Create a site first</DialogTitle>
              <DialogDescription>
                Rooms live inside a site. Add your first site, then come back to add a room.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={onNeedSite}>Create a site</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate({ orgId, siteId, name });
            }}
            className="space-y-5"
          >
            <DialogHeader>
              <DialogTitle>New room</DialogTitle>
              <DialogDescription>
                Add the room, then add its devices.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="room-name">Name</Label>
              <Input
                id="room-name"
                autoFocus
                required
                placeholder="Boardroom 1"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="room-site">Site</Label>
              <SimpleSelect
                id="room-site"
                className="w-full"
                value={siteId}
                onValueChange={setPickedSite}
                options={siteList.map((s) => ({ value: s.id, label: s.name }))}
                placeholder="Choose a site"
              />
            </div>
            {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || !name.trim() || !siteId}>
                {create.isPending && <Spinner />}
                Create room
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
