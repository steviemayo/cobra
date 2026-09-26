'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Server, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { BUILT_IN_DRIVERS, DEVICE_CATALOG, DeviceCategory, type DeviceControl } from '@kestrel/model';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import type { SiteDeviceView } from '@/server/site-devices';
import { useTRPC } from '@/trpc/client';

const NONE = 'none';
const categoryOptions = DeviceCategory.options
  .filter((c) => DEVICE_CATALOG[c].controllable)
  .map((c) => ({ value: c, label: DEVICE_CATALOG[c].label }));
const driverOptions = [
  ...Object.entries(BUILT_IN_DRIVERS).map(([id, info]) => ({ value: id, label: info.name })),
  { value: 'pjlink', label: 'Generic: PJLink' },
  { value: 'tcp', label: 'Generic: TCP' },
];

function controlFor(choice: string): DeviceControl {
  return choice === 'pjlink' || choice === 'tcp'
    ? { kind: 'generic', protocol: choice }
    : { kind: 'driver', driverId: choice };
}

// One physical device used by several rooms (a matrix or DSP serving two rooms, a shared codec).
// Its address and login are kept here once; rooms refer to it from their design. Logins are
// write-only: they can be replaced but never read back.
export function SharedDevicesView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canEdit } = useOrg();
  const sites = useQuery(trpc.site.list.queryOptions({ orgId }));
  const list = useQuery(trpc.siteDevice.list.queryOptions({ orgId }));
  const sets = useQuery({ ...trpc.binding.credentialSets.list.queryOptions({ orgId }), enabled: canEdit });
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.siteDevice.list.queryKey() });
  const del = useMutation(
    trpc.siteDevice.delete.mutationOptions({
      onSuccess: async () => {
        toast.success('Shared device deleted');
        await refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const siteName = (id: string) => sites.data?.find((s) => s.id === id)?.name ?? 'Site';

  return (
    <PageContainer>
      <PageHeader
        title="Shared devices"
        description="One physical device used by several rooms, such as a matrix or DSP serving two rooms or a shared codec. Its address and login live here once. Rooms that share a device must run on the same gateway."
        actions={
          canEdit && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" /> New shared device
            </Button>
          )
        }
      />
      {creating && (
        <CreateForm
          sites={sites.data ?? []}
          onDone={async () => {
            setCreating(false);
            await refresh();
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {list.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : list.isError ? (
        <p className="text-sm text-destructive">{list.error.message}</p>
      ) : list.data.length === 0 && !creating ? (
        <EmptyState
          icon={Server}
          title="No shared devices yet"
          description="Add one when the same physical device serves more than one room."
        />
      ) : (
        <ul className="space-y-3">
          {list.data.map((d) => (
            <li key={d.id} className="space-y-3 rounded-lg border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">{d.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {siteName(d.siteId)} · {DEVICE_CATALOG[d.category as DeviceCategory]?.label ?? d.category} ·{' '}
                    {d.uses.length === 0
                      ? 'not used by any room'
                      : `used by ${[...new Set(d.uses.map((u) => u.roomName))].join(', ')}`}
                  </div>
                </div>
                {canEdit && (
                  <Button size="sm" variant="ghost" aria-label={`Delete ${d.name}`} onClick={() => setDeleting({ id: d.id, name: d.name })}>
                    <Trash2 />
                  </Button>
                )}
              </div>
              {d.conflicts.map((c) => (
                <p key={c.port} className="text-xs text-amber-700 dark:text-amber-300">
                  {c.rooms.join(' and ')} both use the port “{c.port}”. Two rooms will fight over it.
                </p>
              ))}
              {canEdit && <DeviceForm device={d} sets={sets.data ?? []} onDone={refresh} />}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.name}”?`}
        description="A shared device that a room still uses can’t be deleted. Take it out of their designs first."
        confirmLabel="Delete"
        destructive
        onConfirm={() => deleting && del.mutate({ orgId, id: deleting.id })}
      />
    </PageContainer>
  );
}

function CreateForm({
  sites,
  onDone,
  onCancel,
}: {
  sites: { id: string; name: string }[];
  onDone: () => void | Promise<unknown>;
  onCancel: () => void;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [name, setName] = useState('');
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '');
  const [category, setCategory] = useState<DeviceCategory>('audio_matrix');
  const [driver, setDriver] = useState('qsys-core');
  const [exclusive, setExclusive] = useState(false);
  const create = useMutation(
    trpc.siteDevice.create.mutationOptions({
      onSuccess: async () => {
        toast.success('Shared device added. Now enter its address.');
        await onDone();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <div className="mb-4 space-y-2 rounded-lg border border-border bg-card p-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <Input placeholder="Name, for example Level 3 DSP" value={name} onChange={(e) => setName(e.target.value)} />
        <SimpleSelect value={siteId} onValueChange={setSiteId} options={sites.map((s) => ({ value: s.id, label: s.name }))} placeholder="Site" />
        <SimpleSelect value={category} onValueChange={setCategory} options={categoryOptions} placeholder="Kind of device" />
        <SimpleSelect value={driver} onValueChange={setDriver} options={driverOptions} placeholder="Driver" />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={exclusive} onChange={(e) => setExclusive(e.target.checked)} />
        Serves one room at a time (a codec or recorder). A room in use holds it; others are told it is in use.
      </label>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!name.trim() || !siteId || create.isPending}
          onClick={() => create.mutate({ orgId, siteId, name, category, control: controlFor(driver), exclusive })}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

type SharedDevice = SiteDeviceView;

function DeviceForm({
  device,
  sets,
  onDone,
}: {
  device: SharedDevice;
  sets: { id: string; name: string; fields: string[] }[];
  onDone: () => void | Promise<unknown>;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [setId, setSetId] = useState(device.credentialSetId ?? NONE);
  const [exclusive, setExclusive] = useState(device.exclusive);
  const hasSecret = device.slots.some((s) => s.scope === 'secret');
  const changed =
    Object.keys(typed).length > 0 || setId !== (device.credentialSetId ?? NONE) || exclusive !== device.exclusive;
  const save = useMutation(
    trpc.siteDevice.update.mutationOptions({
      onSuccess: async (r) => {
        toast.success(`Saved. Rooms that use it pick it up within about a minute (version ${r.version}).`);
        setTyped({});
        await onDone();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {device.slots.map((s) => (
          <label key={s.key} className="flex flex-col gap-1 text-xs text-muted-foreground">
            {s.label}
            {s.required ? ' (required)' : ''}
            <Input
              type={s.scope === 'secret' ? 'password' : 'text'}
              autoComplete="off"
              placeholder={s.scope === 'secret' ? (s.isSet ? 'Set. Type to replace' : 'Not set') : ''}
              value={typed[s.key] ?? (s.scope === 'binding' ? String(s.value ?? '') : '')}
              onChange={(e) => setTyped((t) => ({ ...t, [s.key]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      {hasSecret && (
        <SimpleSelect
          value={setId}
          onValueChange={setSetId}
          options={[{ value: NONE, label: 'No shared login: use this device’s own' }, ...sets.map((s) => ({ value: s.id, label: `${s.name} (${s.fields.join(', ')})` }))]}
          placeholder="Shared login"
        />
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={exclusive} onChange={(e) => setExclusive(e.target.checked)} />
        Serves one room at a time
      </label>
      <Button
        size="sm"
        disabled={!changed || save.isPending}
        onClick={() =>
          save.mutate({
            orgId,
            id: device.id,
            ...(Object.keys(typed).length ? { set: typed } : {}),
            ...(setId !== (device.credentialSetId ?? NONE) ? { credentialSetId: setId === NONE ? null : setId } : {}),
            ...(exclusive !== device.exclusive ? { exclusive } : {}),
          })
        }
      >
        {save.isPending ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
}
