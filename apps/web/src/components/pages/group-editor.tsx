'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Check, Play, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { enumerateCombinedRooms, validateGroupSpec } from '@kestrel/engine';
import {
  DEFAULT_ON_CLOSE,
  DEFAULT_ON_OPEN,
  TRANSITION_LABELS,
  type TransitionAction,
} from '@kestrel/model';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { GroupDeployDialog } from '@/components/pages/group-deploy-dialog';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useInvalidateEstate, useRoomsOverview, useSites } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';

interface DividerDraft {
  /** Local key, so rows keep their place while editing. */
  key: string;
  /** Set once saved. */
  id?: string;
  name: string;
  roomIds: string[];
  onOpen: TransitionAction;
  onClose: TransitionAction;
}

const TRANSITION_OPTIONS = (Object.keys(TRANSITION_LABELS) as TransitionAction[]).map((value) => ({
  value,
  label: TRANSITION_LABELS[value],
}));

let counter = 0;
const nextKey = () => `d${++counter}`;

/** Create or edit a room group: which rooms, which movable walls join them, and what that makes. */
export function GroupEditor({ groupId }: { groupId: string | null }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const { orgId, canEdit } = useOrg();
  const sites = useSites();
  const rooms = useRoomsOverview();
  const invalidateEstate = useInvalidateEstate();
  const base = `/o/${orgId}/groups`;

  const loaded = useQuery({
    ...trpc.roomGroup.get.queryOptions({ orgId, groupId: groupId ?? '' }),
    enabled: !!groupId,
  });

  const [name, setName] = useState('');
  const [siteId, setSiteId] = useState('');
  const [roomIds, setRoomIds] = useState<string[]>([]);
  const [dividers, setDividers] = useState<DividerDraft[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [saved, setSaved] = useState<string>('');

  const serialise = (n: string, s: string, r: string[], d: DividerDraft[]) =>
    JSON.stringify([n, s, r, d.map((x) => [x.id ?? '', x.name, x.roomIds, x.onOpen, x.onClose])]);

  // Load the saved group into the form once.
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    if (!loaded.data || filled) return;
    const g = loaded.data;
    const ds = g.dividers.map((d) => ({
      key: nextKey(),
      id: d.id,
      name: d.name,
      roomIds: d.roomIds,
      onOpen: d.onOpen,
      onClose: d.onClose,
    }));
    setName(g.name);
    setSiteId(g.siteId);
    setRoomIds(g.rooms.map((r) => r.id));
    setDividers(ds);
    setSaved(
      serialise(
        g.name,
        g.siteId,
        g.rooms.map((r) => r.id),
        ds,
      ),
    );
    setFilled(true);
  }, [loaded.data, filled]);

  const dirty = serialise(name, siteId, roomIds, dividers) !== saved;
  const candidates = useMemo(
    () =>
      (rooms.data ?? []).filter(
        (r) =>
          r.siteId === siteId && r.kind !== 'combined' && (!r.groupId || r.groupId === groupId),
      ),
    [rooms.data, siteId, groupId],
  );
  const nameOf = (id: string) => rooms.data?.find((r) => r.id === id)?.name ?? 'Unknown room';
  const chosen = roomIds.map((id) => rooms.data?.find((r) => r.id === id)).filter(Boolean);
  const gateways = new Set(chosen.map((r) => r!.gateway?.id ?? ''));

  // What the layout makes, worked out here so it updates as you edit.
  const spec = {
    roomIds,
    dividers: dividers.map((d) => ({ id: d.key, name: d.name || ' ', roomIds: d.roomIds })),
  };
  const problems = useMemo(
    () =>
      dividers.some((d) => !d.name.trim()) ? ['Every wall needs a name.'] : validateGroupSpec(spec),
    [roomIds, dividers],
  );
  const enumerated = useMemo(
    () => (problems.length === 0 && roomIds.length >= 2 ? enumerateCombinedRooms(spec) : null),
    [problems, roomIds, dividers],
  );
  const existing = new Map((loaded.data?.combined ?? []).map((c) => [c.key, c.roomId]));
  // Walls the gateway last said are open, so a dev can see the rooms are joined right now.
  const openNow = new Set((loaded.data?.dividers ?? []).filter((d) => d.open).map((d) => d.id));

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: trpc.roomGroup.list.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.roomGroup.get.queryKey() }),
      invalidateEstate(),
    ]);
  };

  const save = useMutation(
    trpc.roomGroup.save.mutationOptions({
      onSuccess: async ({ id }) => {
        await refresh();
        toast.success('Saved');
        if (!groupId) router.replace(`${base}/${id}`);
        else {
          setFilled(false);
        }
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const sync = useMutation(
    trpc.roomGroup.syncCombined.mutationOptions({
      onSuccess: async (r) => {
        await refresh();
        const bits = [
          r.created.length && `created ${r.created.length}`,
          r.removed.length && `removed ${r.removed.length}`,
        ].filter(Boolean);
        toast.success(bits.length ? `Combined rooms: ${bits.join(', ')}` : 'Already up to date');
        for (const s of r.skipped) toast.warning(`${s.name}: ${s.reason}`);
        for (const k of r.kept)
          toast.warning(`${k} is no longer possible but was deployed. Remove it yourself.`);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const del = useMutation(
    trpc.roomGroup.delete.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Group deleted');
        router.replace(base);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (groupId && loaded.isPending)
    return (
      <PageContainer>
        <Skeleton className="h-64 w-full" />
      </PageContainer>
    );

  const toggleRoom = (id: string, on: boolean) => {
    setRoomIds((r) => (on ? [...r, id] : r.filter((x) => x !== id)));
    if (!on)
      setDividers((ds) => ds.map((d) => ({ ...d, roomIds: d.roomIds.filter((x) => x !== id) })));
  };
  const toggleDividerRoom = (key: string, id: string, on: boolean) =>
    setDividers((ds) =>
      ds.map((d) =>
        d.key === key
          ? { ...d, roomIds: on ? [...d.roomIds, id] : d.roomIds.filter((x) => x !== id) }
          : d,
      ),
    );

  const canSave =
    canEdit && name.trim() && siteId && roomIds.length >= 2 && problems.length === 0 && dirty;
  const toCreate = (enumerated?.sets ?? []).filter((s) => !existing.get(s.key)).length;
  const orphaned = loaded.data?.orphaned ?? [];

  return (
    <PageContainer>
      <PageHeader
        title={groupId ? name || 'Room group' : 'New room group'}
        description="Say which rooms share movable walls, and which rooms each wall joins when it is open."
        actions={
          <>
            {groupId && (
              <Button
                size="sm"
                variant="outline"
                render={<Link href={`${base}/${groupId}/simulate`} />}
              >
                <Play data-icon="inline-start" /> Simulate
              </Button>
            )}
            <Button size="sm" variant="ghost" render={<Link href={base} />}>
              <ArrowLeft data-icon="inline-start" /> All groups
            </Button>
          </>
        }
      />

      <section className="space-y-4 rounded-lg border p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="grp-name">Name</Label>
            <Input
              id="grp-name"
              placeholder="Level 2 function rooms"
              value={name}
              disabled={!canEdit}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="grp-site">Site</Label>
            <SimpleSelect
              id="grp-site"
              className="w-full"
              value={siteId}
              placeholder="Choose a site"
              disabled={!canEdit || !!groupId}
              onValueChange={(v) => {
                setSiteId(v);
                setRoomIds([]);
                setDividers([]);
              }}
              options={(sites.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Rooms</legend>
          <p className="text-xs text-muted-foreground">
            Ordinary rooms at this site that share movable walls. They are controlled together when
            joined, so they must all run on the same gateway. Add each room’s design first: combined
            rooms are built from those designs.
          </p>
          <div className="max-h-56 space-y-1 overflow-auto rounded-md border p-2">
            {!siteId && <p className="text-sm text-muted-foreground">Choose a site first.</p>}
            {siteId && candidates.length === 0 && (
              <p className="text-sm text-muted-foreground">No free rooms at this site.</p>
            )}
            {candidates.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={roomIds.includes(r.id)}
                  disabled={!canEdit}
                  onCheckedChange={(on) => toggleRoom(r.id, !!on)}
                />
                {r.name}
                <span className="text-xs text-muted-foreground">
                  {r.gateway ? r.gateway.name : 'no gateway yet'}
                </span>
              </label>
            ))}
          </div>
          {gateways.size > 1 && (
            <p className="flex items-center gap-1.5 text-sm text-warning">
              <AlertTriangle className="size-4" /> These rooms are on different gateways. Rooms in a
              group must all run on one.
            </p>
          )}
        </fieldset>
      </section>

      <section className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">Movable walls</h2>
            <p className="text-xs text-muted-foreground">
              A wall joins every room you tick when it is open. Tick three rooms for a wall that
              opens one room onto two others at once.
            </p>
          </div>
          {canEdit && (
            <Button
              size="sm"
              variant="outline"
              disabled={roomIds.length < 2}
              onClick={() =>
                setDividers((d) => [
                  ...d,
                  {
                    key: nextKey(),
                    name: `Wall ${d.length + 1}`,
                    roomIds: [],
                    onOpen: DEFAULT_ON_OPEN,
                    onClose: DEFAULT_ON_CLOSE,
                  },
                ])
              }
            >
              <Plus data-icon="inline-start" /> Add wall
            </Button>
          )}
        </div>
        {dividers.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {roomIds.length < 2 ? 'Choose at least two rooms first.' : 'No walls yet.'}
          </p>
        )}
        {dividers.map((d) => (
          <div key={d.key} className="space-y-2 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <Input
                aria-label="Wall name"
                className="max-w-xs"
                value={d.name}
                disabled={!canEdit}
                onChange={(e) =>
                  setDividers((ds) =>
                    ds.map((x) => (x.key === d.key ? { ...x, name: e.target.value } : x)),
                  )
                }
              />
              {d.id && openNow.has(d.id) && (
                <span className="inline-flex items-center gap-1 text-xs text-success">
                  <Check className="size-3.5" /> Open now
                </span>
              )}
              {canEdit && (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${d.name}`}
                  onClick={() => setDividers((ds) => ds.filter((x) => x.key !== d.key))}
                >
                  <Trash2 />
                </Button>
              )}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {roomIds.map((id) => (
                <label key={id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={d.roomIds.includes(id)}
                    disabled={!canEdit}
                    onCheckedChange={(on) => toggleDividerRoom(d.key, id, !!on)}
                  />
                  {nameOf(id)}
                </label>
              ))}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ['onOpen', 'When it opens, the joined room', `grp-open-${d.key}`],
                  ['onClose', 'When it closes, each room', `grp-close-${d.key}`],
                ] as const
              ).map(([field, label, id]) => (
                <div key={field} className="space-y-1">
                  <Label htmlFor={id} className="text-xs text-muted-foreground">
                    {label}
                  </Label>
                  <SimpleSelect
                    id={id}
                    className="w-full"
                    value={d[field]}
                    disabled={!canEdit}
                    onValueChange={(v) =>
                      setDividers((ds) =>
                        ds.map((x) =>
                          x.key === d.key ? { ...x, [field]: v as TransitionAction } : x,
                        ),
                      )
                    }
                    options={TRANSITION_OPTIONS}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-3 rounded-lg border p-4">
        <div>
          <h2 className="text-sm font-medium">Combined rooms this makes</h2>
          <p className="text-xs text-muted-foreground">
            One for every set of rooms the walls can join. Each starts from its rooms’ designs; you
            then finish its design (mainly how the rooms are wired to each other) like any room.
          </p>
        </div>
        {problems.length > 0 && roomIds.length >= 2 && dividers.length > 0 && (
          <ul className="space-y-1 text-sm text-destructive">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {enumerated?.truncated && (
          <p className="text-sm text-destructive">
            This layout makes too many combined rooms. Remove a wall that touches many rooms.
          </p>
        )}
        {enumerated && enumerated.sets.length === 0 && (
          <p className="text-sm text-muted-foreground">Add walls to see the combined rooms.</p>
        )}
        <ul className="divide-y rounded-md border">
          {enumerated?.sets.map((s) => {
            const made = existing.get(s.key);
            return (
              <li key={s.key} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span>{s.roomIds.map(nameOf).join(' + ')}</span>
                {made ? (
                  <Link
                    className="inline-flex items-center gap-1 text-xs text-success"
                    href={`/o/${orgId}/rooms/${made}`}
                  >
                    <Check className="size-3.5" /> Created
                  </Link>
                ) : (
                  <span className="text-xs text-muted-foreground">Not created yet</span>
                )}
              </li>
            );
          })}
        </ul>
        {orphaned.length > 0 && (
          <div className="space-y-1 text-sm">
            <p className="text-warning">No longer possible with these walls:</p>
            <ul className="list-disc pl-5 text-muted-foreground">
              {orphaned.map((o) => (
                <li key={o.roomId}>
                  {o.name} {o.deployed && '(deployed: remove it yourself)'}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={!canSave || save.isPending}
            onClick={() =>
              save.mutate({
                orgId,
                groupId: groupId ?? undefined,
                name,
                siteId,
                roomIds,
                dividers: dividers.map((d) => ({
                  id: d.id,
                  name: d.name,
                  roomIds: d.roomIds,
                  onOpen: d.onOpen,
                  onClose: d.onClose,
                })),
              })
            }
          >
            {save.isPending && <Spinner />} Save
          </Button>
          {groupId && (
            <Button
              variant="outline"
              disabled={dirty || sync.isPending || (toCreate === 0 && orphaned.length === 0)}
              title={dirty ? 'Save your changes first' : undefined}
              onClick={() => sync.mutate({ orgId, groupId })}
            >
              {sync.isPending && <Spinner />} Update combined rooms
              {toCreate > 0 && ` (${toCreate} to create)`}
            </Button>
          )}
          {groupId && (
            <Button
              variant="outline"
              disabled={dirty}
              title={dirty ? 'Save your changes first' : undefined}
              onClick={() => setDeployOpen(true)}
            >
              Deploy group
            </Button>
          )}
          {groupId && (
            <Button
              variant="ghost"
              className="ml-auto text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              Delete group
            </Button>
          )}
        </div>
      )}

      {groupId && (
        <GroupDeployDialog groupId={groupId} open={deployOpen} onOpenChange={setDeployOpen} />
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this room group?"
        description="Its combined rooms are deleted too. The ordinary rooms stay. This is refused if a combined room has been deployed."
        confirmLabel="Delete group"
        destructive
        onConfirm={() => groupId && del.mutate({ orgId, groupId })}
      />
    </PageContainer>
  );
}
