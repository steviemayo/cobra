'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, MoreHorizontal, Plus, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useRoomsOverview } from '@/lib/use-estate';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Combination = RouterOutputs['combination']['list'][number];
type Mode = 'follow' | 'blank';

const VIDEO: Record<Mode, string> = {
  follow: 'Show what the main room shows',
  blank: 'Keep displays blank',
};
const AUDIO: Record<Mode, string> = {
  follow: 'Match the main room’s volume',
  blank: 'Keep speakers muted',
};

export function CombinationsView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canEdit, canSupport } = useOrg();
  const list = useQuery({
    ...trpc.combination.list.queryOptions({ orgId }),
    refetchInterval: 10_000,
  });
  const [editing, setEditing] = useState<Combination | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Combination | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.combination.list.queryKey() });
  const set = useMutation(
    trpc.combination.setCombined.mutationOptions({
      onSuccess: () =>
        toast.success('Sent to the room. It takes effect within about half a minute'),
      onError: (e) => toast.error(e.message),
    }),
  );
  const del = useMutation(
    trpc.combination.delete.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Removed');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <PageContainer>
      <PageHeader
        title="Combined rooms"
        description="Join rooms into one, for example by opening an operable wall. One panel then controls them all."
        actions={
          canEdit && (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus data-icon="inline-start" /> New combination
            </Button>
          )
        }
      />
      {list.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : list.data?.length === 0 ? (
        <EmptyState
          icon={Link2}
          title="No combined rooms"
          description="Pick a main room and the rooms that join it. They must be at one site and run on one gateway."
          action={
            canEdit ? <Button onClick={() => setEditing('new')}>New combination</Button> : undefined
          }
        />
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {list.data?.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 space-y-0.5">
                <div className="flex items-center gap-2 font-medium">
                  {c.name}
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5 text-xs font-normal',
                      c.combined ? 'text-success' : 'text-muted-foreground',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'size-1.5 rounded-full',
                        c.combined ? 'bg-success' : 'bg-muted-foreground/50',
                      )}
                    />
                    {c.combined ? 'Combined' : 'Apart'}
                  </span>
                </div>
                <div className="text-sm text-muted-foreground">
                  {c.primaryName} <span aria-hidden>+</span> {c.secondaryNames.join(', ')}
                </div>
                <div className="text-xs text-muted-foreground">
                  Other rooms: {VIDEO[c.secondaryVideo as Mode].toLowerCase()};{' '}
                  {AUDIO[c.secondaryAudio as Mode].toLowerCase()}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {canSupport && (
                  <Button
                    size="sm"
                    variant={c.combined ? 'outline' : 'default'}
                    disabled={set.isPending}
                    onClick={() =>
                      set.mutate({ orgId, combinationId: c.id, combined: !c.combined })
                    }
                  >
                    {set.isPending && set.variables?.combinationId === c.id ? (
                      <Spinner />
                    ) : c.combined ? (
                      <Unlink data-icon="inline-start" />
                    ) : (
                      <Link2 data-icon="inline-start" />
                    )}
                    {c.combined ? 'Split' : 'Combine'}
                  </Button>
                )}
                {canEdit && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Actions for ${c.name}`}
                        />
                      }
                    >
                      <MoreHorizontal />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setEditing(c)}>Edit</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setDeleting(c)}>
                        Remove
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <CombinationDialog
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        destructive
        title={`Remove “${deleting?.name}”?`}
        description="The rooms stay as they are. If they are combined right now, split them first."
        confirmLabel="Remove"
        onConfirm={() => deleting && del.mutate({ orgId, combinationId: deleting.id })}
      />
    </PageContainer>
  );
}

function CombinationDialog({
  existing,
  onClose,
  onSaved,
}: {
  existing: Combination | null;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const rooms = useRoomsOverview();
  const [name, setName] = useState(existing?.name ?? '');
  const [primary, setPrimary] = useState(existing?.primaryRoomId ?? '');
  const [secondary, setSecondary] = useState<string[]>(existing?.secondaryRoomIds ?? []);
  const [video, setVideo] = useState<Mode>((existing?.secondaryVideo as Mode) ?? 'follow');
  const [audio, setAudio] = useState<Mode>((existing?.secondaryAudio as Mode) ?? 'follow');

  const usable = (rooms.data ?? []).filter((r) => r.gateway);
  const done = async () => {
    await onSaved();
    toast.success('Saved. The room picks it up within about half a minute');
  };
  const create = useMutation(trpc.combination.create.mutationOptions({ onSuccess: done }));
  const update = useMutation(trpc.combination.update.mutationOptions({ onSuccess: done }));
  const active = existing ? update : create;
  const body = {
    orgId,
    name,
    primaryRoomId: primary,
    secondaryRoomIds: secondary,
    secondaryVideo: video,
    secondaryAudio: audio,
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (existing) update.mutate({ ...body, combinationId: existing.id });
            else create.mutate(body);
          }}
        >
          <DialogHeader>
            <DialogTitle>{existing ? 'Edit combined rooms' : 'New combination'}</DialogTitle>
            <DialogDescription>
              The main room’s panel controls every room while they’re combined. Splitting turns the
              others off.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="cmb-name">Name</Label>
            <Input
              id="cmb-name"
              autoFocus
              required
              placeholder="Ballroom"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cmb-primary">Main room</Label>
            <SimpleSelect
              id="cmb-primary"
              className="w-full"
              value={primary}
              placeholder="Choose the room whose panel is in charge"
              onValueChange={(v) => {
                setPrimary(v);
                setSecondary((s) => s.filter((x) => x !== v));
              }}
              options={usable.map((r) => ({ value: r.id, label: `${r.name} (${r.site.name})` }))}
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Rooms that join it</legend>
            <div className="max-h-40 space-y-1 overflow-auto rounded-md border p-2">
              {usable
                .filter((r) => r.id !== primary)
                .map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={secondary.includes(r.id)}
                      onCheckedChange={(on) =>
                        setSecondary((s) => (on ? [...s, r.id] : s.filter((x) => x !== r.id)))
                      }
                    />
                    {r.name}
                  </label>
                ))}
              {usable.length === 0 && (
                <p className="text-sm text-muted-foreground">No rooms are on a gateway yet.</p>
              )}
            </div>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="cmb-video">Displays in the other rooms</Label>
              <SimpleSelect
                id="cmb-video"
                className="w-full"
                value={video}
                onValueChange={setVideo}
                options={(Object.keys(VIDEO) as Mode[]).map((value) => ({
                  value,
                  label: VIDEO[value],
                }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cmb-audio">Speakers in the other rooms</Label>
              <SimpleSelect
                id="cmb-audio"
                className="w-full"
                value={audio}
                onValueChange={setAudio}
                options={(Object.keys(AUDIO) as Mode[]).map((value) => ({
                  value,
                  label: AUDIO[value],
                }))}
              />
            </div>
          </div>
          {active.error && <p className="text-sm text-destructive">{active.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={active.isPending || !name.trim() || !primary || secondary.length === 0}
            >
              {active.isPending && <Spinner />}
              {existing ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
