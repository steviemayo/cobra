'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, Pencil, Plus, Router, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { HealthPill } from '@/components/common/health';
import { GatewayStatus } from '@/components/common/status';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { SimpleSelect } from '@/components/common/simple-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { plural } from '@/lib/format';
import { useEstateOverview } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Area = RouterOutputs['area']['list'][number];

/** The areas of one site (a building, a level, a wing): add, rename, delete. Nests three deep. */
export function AreasPanel({ siteId }: { siteId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport, canEdit } = useOrg();
  const areas = useQuery(trpc.area.list.queryOptions({ orgId, siteId }));
  const estate = useEstateOverview();
  // Adding under a parent ('' is at the top of the site), or renaming one.
  const [adding, setAdding] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [deleting, setDeleting] = useState<Area | null>(null);

  const done = async () => {
    setAdding(null);
    setRenaming(null);
    setName('');
    setLabel('');
    await Promise.all([
      qc.invalidateQueries({ queryKey: trpc.area.list.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.monitoring.estate.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.room.overview.queryKey() }),
    ]);
  };
  const fail = (e: { message: string }) => toast.error(e.message);
  const create = useMutation(trpc.area.create.mutationOptions({ onSuccess: done, onError: fail }));
  const update = useMutation(trpc.area.update.mutationOptions({ onSuccess: done, onError: fail }));
  const remove = useMutation(
    trpc.area.delete.mutationOptions({
      onSuccess: async () => {
        toast.success('Area deleted. Its rooms are now outside any area.');
        await done();
      },
      onError: fail,
    }),
  );

  if (areas.isPending) return <Skeleton className="h-20 w-full" />;
  const list = areas.data ?? [];
  const roomCount = (id: string) =>
    (estate.data?.rooms ?? []).filter((r) => r.areaId === id).length;

  const form = (onSubmit: () => void, busy: boolean) => (
    <div className="flex flex-wrap items-center gap-2 py-1.5">
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name, for example Level 2"
        className="h-8 w-56"
        maxLength={80}
        aria-label="Area name"
        onKeyDown={(e) => e.key === 'Enter' && name.trim() && !busy && onSubmit()}
      />
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Kind (Building, Level, Wing)"
        className="h-8 w-52"
        maxLength={40}
        aria-label="What this level is called"
        onKeyDown={(e) => e.key === 'Enter' && name.trim() && !busy && onSubmit()}
      />
      <Button size="sm" disabled={!name.trim() || busy} onClick={onSubmit}>
        Save
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setAdding(null);
          setRenaming(null);
        }}
      >
        Cancel
      </Button>
    </div>
  );

  const row = (a: Area, depth: number): React.ReactNode => (
    <div key={a.id}>
      {renaming === a.id ? (
        <div style={{ paddingLeft: depth * 20 }}>
          {form(
            () =>
              update.mutate({
                orgId,
                areaId: a.id,
                name: name.trim(),
                label: label.trim() || null,
              }),
            update.isPending,
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 py-1.5 text-sm" style={{ paddingLeft: depth * 20 }}>
          <Layers className="size-3.5 text-muted-foreground" />
          <span className="font-medium">{a.name}</span>
          {a.label && <span className="text-xs text-muted-foreground">{a.label}</span>}
          <span className="text-xs text-muted-foreground">{plural(roomCount(a.id), 'room')}</span>
          {canSupport && (
            <span className="ml-auto flex gap-1">
              {depth < 2 && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setAdding(a.id);
                    setName('');
                    setLabel('');
                  }}
                >
                  <Plus data-icon="inline-start" /> Inside
                </Button>
              )}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Rename ${a.name}`}
                onClick={() => {
                  setRenaming(a.id);
                  setName(a.name);
                  setLabel(a.label ?? '');
                }}
              >
                <Pencil />
              </Button>
              {canEdit && (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Delete ${a.name}`}
                  onClick={() => setDeleting(a)}
                >
                  <Trash2 />
                </Button>
              )}
            </span>
          )}
        </div>
      )}
      {adding === a.id && (
        <div style={{ paddingLeft: (depth + 1) * 20 }}>
          {form(
            () =>
              create.mutate({
                orgId,
                siteId,
                parentId: a.id,
                name: name.trim(),
                label: label.trim() || null,
              }),
            create.isPending,
          )}
        </div>
      )}
      {list.filter((c) => c.parentId === a.id).map((c) => row(c, depth + 1))}
    </div>
  );

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Areas</h2>
        {canSupport && adding !== '' && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setAdding('');
              setName('');
              setLabel('');
            }}
          >
            <Plus data-icon="inline-start" /> Add area
          </Button>
        )}
      </div>
      <div className="rounded-lg border px-4 py-2">
        {list.length === 0 && adding !== '' ? (
          <p className="py-2 text-sm text-muted-foreground">
            Group this site&apos;s rooms by building, level, wing or whatever suits you. Areas are
            optional and can sit inside each other.
          </p>
        ) : (
          list.filter((a) => !a.parentId).map((a) => row(a, 0))
        )}
        {adding === '' &&
          form(
            () => create.mutate({ orgId, siteId, name: name.trim(), label: label.trim() || null }),
            create.isPending,
          )}
      </div>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        description="Areas inside it are deleted too. Rooms are kept and move out of any area."
        confirmLabel="Delete"
        destructive
        onConfirm={() => deleting && remove.mutate({ orgId, areaId: deleting.id })}
      />
    </section>
  );
}

/** The rooms of one site as the Overview shows them: status, area, devices. */
export function SiteRooms({ siteId }: { siteId: string }) {
  const { orgId } = useOrg();
  const estate = useEstateOverview();
  if (estate.isPending) return <Skeleton className="h-24 w-full" />;
  const rooms = (estate.data?.rooms ?? []).filter((r) => r.siteId === siteId);
  if (rooms.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead>Live status</TableHead>
            <TableHead>Room</TableHead>
            <TableHead>Area</TableHead>
            <TableHead>Devices</TableHead>
            <TableHead>Gateway</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rooms.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <HealthPill level={r.health.level} reasons={r.health.reasons} />
              </TableCell>
              <TableCell className="font-medium">
                <Link href={orgPath(orgId, `/rooms/${r.id}`)} className="hover:underline">
                  {r.name}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">{r.areaPath || '–'}</TableCell>
              <TableCell className="tabular text-sm">
                {r.devices.active
                  ? `${r.devices.online} of ${r.devices.active} online`
                  : r.devices.passive
                    ? `${r.devices.passive} recorded`
                    : '–'}
              </TableCell>
              <TableCell>
                <GatewayStatus
                  gateway={
                    r.gateways[0]
                      ? {
                          name: r.gateways[0].name,
                          status: r.gatewayStatus ?? r.gateways[0].status,
                        }
                      : null
                  }
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** The gateways at one site, with the state of each, and which one takes devices that have none of their own. */
export function SiteGateways({ siteId }: { siteId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canEdit } = useOrg();
  const gateways = useQuery(trpc.gateway.list.queryOptions({ orgId }));
  const sites = useQuery(trpc.site.list.queryOptions({ orgId }));
  const setDefault = useMutation(
    trpc.site.update.mutationOptions({
      onSuccess: async () => {
        toast.success('Saved');
        await Promise.all([
          qc.invalidateQueries({ queryKey: trpc.site.list.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.monitoring.estate.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.device.list.queryKey() }),
        ]);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (gateways.isPending) return <Skeleton className="h-16 w-full" />;
  const list = (gateways.data ?? []).filter((g) => g.siteId === siteId);
  if (list.length === 0)
    return (
      <p className="flex items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
        <Router className="size-4" /> No gateways at this site yet. Add one on the Gateways page.
      </p>
    );
  const current = sites.data?.find((s) => s.id === siteId)?.defaultGatewayId ?? null;
  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-lg border">
        {list.map((g) => (
          <li key={g.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
            <span className="inline-flex items-center gap-3">
              <GatewayStatus gateway={{ name: g.name, status: g.status }} />
              {(current ?? list[0]!.id) === g.id && (
                <span className="text-xs text-muted-foreground">
                  {current ? 'Default for this site' : 'Default (oldest)'}
                </span>
              )}
            </span>
            <Link
              href={orgPath(orgId, '/gateways')}
              className="text-xs text-muted-foreground hover:underline"
            >
              Manage
            </Link>
          </li>
        ))}
      </ul>
      {canEdit && list.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Devices with no gateway of their own use</span>
          <SimpleSelect
            size="sm"
            className="w-56"
            value={current ?? list[0]!.id}
            onValueChange={(v) => setDefault.mutate({ orgId, siteId, defaultGatewayId: v })}
            options={list.map((g) => ({ value: g.id, label: g.name }))}
          />
        </div>
      )}
    </div>
  );
}
