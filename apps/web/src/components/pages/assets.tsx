'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarCheck, Download, Package, Plus, Radar, Search } from 'lucide-react';
import { toast } from 'sonner';
import {
  ASSET_ONLY_CATEGORIES,
  BUILT_IN_DRIVERS,
  DEVICE_CATALOG,
  DeviceCategory,
  assetCategoryLabel,
  type DeviceControl,
} from '@kestrel/model';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { downloadFile } from '@/lib/download';
import { plural } from '@/lib/format';
import { useEstate } from '@/lib/use-estate';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';
import {
  ConnectionFields,
  connectionMissing,
  connectionPatch,
  connectionSlots,
  emptyConnection,
  type ConnectionDraft,
} from './device-connection';
import { AlignDatesDialog, FixGapsDialog, GAPS, gapKeysOf, type GapKey } from './asset-gaps';
import { DeviceStateBadge } from './device-detail';
import { AddressTrackingFields } from './device-address';
import { FindDevicesDialog } from './find-devices';
import { ImportRegisterDialog } from './import-register-dialog';

export type DeviceRow = RouterOutputs['device']['list'][number];

const ALL = '__all';
type GroupBy = 'none' | 'site' | 'room' | 'category' | 'area';

const CATEGORY_OPTIONS = [
  ...DeviceCategory.options.map((c) => ({ value: c as string, label: DEVICE_CATALOG[c].label })),
  ...ASSET_ONLY_CATEGORIES.map((c) => ({ value: c as string, label: assetCategoryLabel(c) })),
];
export const DRIVER_OPTIONS = [
  ...Object.entries(BUILT_IN_DRIVERS).map(([id, info]) => ({ value: id, label: info.name })),
  { value: 'pjlink', label: 'Generic: PJLink' },
  { value: 'tcp', label: 'Generic: TCP' },
];

const GENERIC_DRIVER_OPTIONS = [
  { value: 'pjlink', label: 'Generic: PJLink' },
  { value: 'tcp', label: 'Generic: TCP' },
];

/**
 * The drivers that suit a category: the built-in ones that name it, by name, then the generic ones.
 * A category no driver names (an asset-only kind) gets the whole list, so nothing is ever unreachable.
 */
export function driverOptionsFor(category: string) {
  const matching = Object.entries(BUILT_IN_DRIVERS)
    .filter(([, info]) => (info.categories as string[]).includes(category))
    .map(([id, info]) => ({ value: id, label: info.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return matching.length > 0 ? [...matching, ...GENERIC_DRIVER_OPTIONS] : DRIVER_OPTIONS;
}

export function controlFor(choice: string): DeviceControl {
  return choice === 'pjlink' || choice === 'tcp'
    ? { kind: 'generic', protocol: choice }
    : { kind: 'driver', driverId: choice };
}

const dayText = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : '–');

const csvCell = (v: unknown) => {
  const s =
    v === null || v === undefined
      ? ''
      : v instanceof Date
        ? v.toISOString().slice(0, 10)
        : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function AssetsView() {
  const trpc = useTRPC();
  const { orgId, canEdit } = useOrg();
  const { sites, rooms } = useEstate();
  const devices = useQuery({
    ...trpc.device.list.queryOptions({ orgId }),
    refetchInterval: 30_000,
  });
  const areas = useQuery(trpc.area.list.queryOptions({ orgId }));
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [finding, setFinding] = useState(false);
  const [search, setSearch] = useState('');
  const [siteId, setSiteId] = useState('');
  const [category, setCategory] = useState('');
  const [kind, setKind] = useState('');
  /** '' shows everything, 'any' every device with a gap, or one kind of gap. */
  const [gapFilter, setGapFilter] = useState<'' | 'any' | GapKey>('');
  const [aligning, setAligning] = useState(false);
  const [fixingId, setFixingId] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('site');

  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? 'Site';
  const areaName = (id: string | null) => areas.data?.find((a) => a.id === id)?.name ?? 'No area';

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (devices.data ?? []).filter((d) => {
      if (siteId && d.siteId !== siteId) return false;
      if (category && d.category !== category) return false;
      if (kind && d.kind !== kind) return false;
      if (gapFilter) {
        const keys = gapKeysOf(d);
        if (gapFilter === 'any' ? keys.length === 0 : !keys.includes(gapFilter)) return false;
      }
      if (!q) return true;
      return [d.name, d.roomName, d.make, d.model, d.serial, d.mac, d.ip, d.assetTag, d.firmware]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [devices.data, search, siteId, category, kind, gapFilter]);

  const groups = useMemo(() => {
    const key = (d: DeviceRow) =>
      groupBy === 'site'
        ? siteName(d.siteId)
        : groupBy === 'room'
          ? (d.roomName ?? 'Not in a room')
          : groupBy === 'category'
            ? assetCategoryLabel(d.category)
            : groupBy === 'area'
              ? areaName(d.areaId)
              : '';
    const map = new Map<string, DeviceRow[]>();
    for (const d of filtered) map.set(key(d), [...(map.get(key(d)) ?? []), d]);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered, groupBy, sites, areas.data]);

  const all = devices.data ?? [];
  const complete = all.length ? all.filter((d) => gapKeysOf(d).length === 0).length : 0;
  const gapCounts = GAPS.map((g) => ({ ...g, count: all.filter((d) => g.missing(d)).length }));
  const swaps = all.filter((d) => d.swapPending).length;

  // "Save and next" walks the devices with gaps in the order they are listed on screen.
  const fixQueue = groups.flatMap(([, rows]) => rows).filter((d) => gapKeysOf(d).length > 0);
  const fixing = fixingId ? all.find((d) => d.id === fixingId) : undefined;
  const fixIndex = fixing ? fixQueue.findIndex((d) => d.id === fixing.id) : -1;
  const fixNext = fixIndex >= 0 ? (fixQueue[fixIndex + 1] ?? null) : (fixQueue[0] ?? null);

  function exportCsv() {
    const head = [
      'Name',
      'Type',
      'Category',
      'Site',
      'Room',
      'Make',
      'Model',
      'Serial',
      'MAC',
      'IP',
      'Firmware',
      'Asset tag',
      'Status',
      'Installed',
      'Warranty ends',
      'End of life',
      'Supplier',
    ];
    const rows = filtered.map((d) =>
      [
        d.name,
        d.kind,
        assetCategoryLabel(d.category),
        siteName(d.siteId),
        d.roomName,
        d.make,
        d.model,
        d.serial,
        d.mac,
        d.ip,
        d.firmware,
        d.assetTag,
        d.status,
        d.installedOn,
        d.warrantyEndsOn,
        d.endOfLifeOn,
        d.supplier,
      ]
        .map(csvCell)
        .join(','),
    );
    downloadFile({
      filename: `asset-register-${new Date().toISOString().slice(0, 10)}.csv`,
      contentType: 'text/csv',
      body: [head.join(','), ...rows].join('\n'),
    });
  }

  return (
    <PageContainer>
      <PageHeader
        title="Asset register"
        description="Every device in the estate, monitored or not. Values the device reports itself fill in on their own; type in whatever is missing."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={exportCsv}
              disabled={filtered.length === 0}
            >
              <Download data-icon="inline-start" /> Export CSV
            </Button>
            {canEdit && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAligning(true)}
                disabled={all.length === 0}
              >
                <CalendarCheck data-icon="inline-start" /> Align dates
              </Button>
            )}
            {canEdit && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setImporting(true)}
                disabled={sites.length === 0}
              >
                Import CSV
              </Button>
            )}
            {canEdit && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setFinding(true)}
                disabled={sites.length === 0}
              >
                <Radar data-icon="inline-start" /> Find devices
              </Button>
            )}
            {canEdit && (
              <Button size="sm" onClick={() => setAdding(true)} disabled={sites.length === 0}>
                <Plus data-icon="inline-start" /> Add device
              </Button>
            )}
          </>
        }
      />

      {devices.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : devices.isError ? (
        <p className="text-sm text-destructive">{devices.error.message}</p>
      ) : all.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No devices yet"
          description="Add a device to a room. A networked one with a driver is monitored; anything else is recorded as an asset."
          action={
            canEdit && sites.length > 0 ? (
              <Button onClick={() => setAdding(true)}>Add a device</Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 divide-x overflow-hidden rounded-lg border sm:grid-cols-4">
            <div className="px-4 py-3">
              <div className="text-xs text-muted-foreground">Devices</div>
              <div className="tabular mt-1 text-2xl font-semibold">{all.length}</div>
            </div>
            <div className="px-4 py-3">
              <div className="text-xs text-muted-foreground">Monitored</div>
              <div className="tabular mt-1 text-2xl font-semibold">
                {all.filter((d) => d.kind === 'active').length}
              </div>
            </div>
            <button
              type="button"
              className="px-4 py-3 text-left transition-colors hover:bg-muted/50"
              onClick={() => setGapFilter(gapFilter === 'any' ? '' : 'any')}
            >
              <div className="text-xs text-muted-foreground">Register complete</div>
              <div className="tabular mt-1 text-2xl font-semibold">
                {Math.round((complete / all.length) * 100)}%
              </div>
              <div className="text-xs text-muted-foreground">
                {gapFilter === 'any' ? 'Showing gaps only' : `${all.length - complete} with gaps`}
              </div>
            </button>
            <div className="px-4 py-3">
              <div className="text-xs text-muted-foreground">Serial changes to review</div>
              <div
                className={cn('tabular mt-1 text-2xl font-semibold', swaps > 0 && 'text-warning')}
              >
                {swaps}
              </div>
            </div>
          </div>

          {all.length > complete && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">Missing:</span>
              {gapCounts
                .filter((g) => g.count > 0)
                .map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    aria-pressed={gapFilter === g.key}
                    onClick={() => setGapFilter(gapFilter === g.key ? '' : g.key)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 transition-colors hover:bg-muted/50',
                      gapFilter === g.key && 'border-foreground bg-muted',
                    )}
                  >
                    {g.label} <span className="tabular text-muted-foreground">{g.count}</span>
                  </button>
                ))}
              {canEdit && fixQueue.length > 0 && (
                <Button
                  size="xs"
                  variant="outline"
                  className="ml-auto"
                  onClick={() => setFixingId(fixQueue[0]!.id)}
                >
                  Fill in gaps one by one
                </Button>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-48 flex-1 sm:max-w-64">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, serial, MAC, IP"
                className="h-8 pl-8"
                aria-label="Search devices"
              />
            </div>
            <SimpleSelect
              size="sm"
              className="w-36"
              value={siteId}
              placeholder="All sites"
              onValueChange={(v) => setSiteId(v === ALL ? '' : v)}
              options={[
                { value: ALL, label: 'All sites' },
                ...sites.map((s) => ({ value: s.id, label: s.name })),
              ]}
            />
            <SimpleSelect
              size="sm"
              className="w-44"
              value={category}
              placeholder="All categories"
              onValueChange={(v) => setCategory(v === ALL ? '' : v)}
              options={[{ value: ALL, label: 'All categories' }, ...CATEGORY_OPTIONS]}
            />
            <SimpleSelect
              size="sm"
              className="w-36"
              value={kind}
              placeholder="Any type"
              onValueChange={(v) => setKind(v === ALL ? '' : v)}
              options={[
                { value: ALL, label: 'Any type' },
                { value: 'active', label: 'Monitored' },
                { value: 'passive', label: 'Recorded only' },
              ]}
            />
            <SimpleSelect
              size="sm"
              className="w-40"
              value={groupBy}
              onValueChange={(v) => setGroupBy(v as GroupBy)}
              options={[
                { value: 'site', label: 'Group by site' },
                { value: 'area', label: 'Group by area' },
                { value: 'room', label: 'Group by room' },
                { value: 'category', label: 'Group by category' },
                { value: 'none', label: 'No grouping' },
              ]}
            />
            <span className="ml-auto text-xs text-muted-foreground">
              {plural(filtered.length, 'device')}
            </span>
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              icon={Package}
              title="No devices match"
              description="Try clearing a filter."
            />
          ) : (
            groups.map(([name, rows]) => (
              <section key={name} className="space-y-2">
                {groupBy !== 'none' && (
                  <h2 className="text-sm font-medium">
                    {name}{' '}
                    <span className="font-normal text-muted-foreground">
                      {plural(rows.length, 'device')}
                    </span>
                  </h2>
                )}
                <div className="overflow-hidden rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableHead>Device</TableHead>
                        <TableHead>Room</TableHead>
                        <TableHead>Make / model</TableHead>
                        <TableHead>Serial</TableHead>
                        <TableHead>IP / MAC</TableHead>
                        <TableHead>Firmware</TableHead>
                        <TableHead>Lifecycle</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead className="text-right">Gaps</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((d) => {
                        const gaps = gapKeysOf(d);
                        const href = orgPath(orgId, `/devices/${d.id}`);
                        return (
                          <TableRow key={d.id}>
                            <TableCell className="font-medium">
                              <Link
                                href={href}
                                className="inline-flex items-center gap-2 hover:underline"
                              >
                                {d.name}
                                {d.swapPending && (
                                  <span title="Serial, MAC or model changed: replaced or a correction?">
                                    <AlertTriangle className="size-3.5 text-warning" />
                                  </span>
                                )}
                              </Link>
                              <div className="text-xs font-normal text-muted-foreground">
                                {assetCategoryLabel(d.category)}
                                {d.kind === 'passive' && <> · recorded only</>}
                              </div>
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {d.roomId ? (
                                <Link
                                  href={orgPath(orgId, `/rooms/${d.roomId}`)}
                                  className="hover:underline"
                                >
                                  {d.roomName}
                                </Link>
                              ) : (
                                '–'
                              )}
                            </TableCell>
                            <TableCell className="text-sm">
                              {[d.make, d.model].filter(Boolean).join(' ') || (
                                <span className="text-muted-foreground">–</span>
                              )}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {d.serial ?? <span className="text-muted-foreground">–</span>}
                            </TableCell>
                            <TableCell className="text-xs">
                              <div>{d.ip ?? '–'}</div>
                              <div className="font-mono text-muted-foreground">{d.mac ?? ''}</div>
                            </TableCell>
                            <TableCell className="text-sm">
                              {d.firmware ?? <span className="text-muted-foreground">–</span>}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              <div>Installed {dayText(d.installedOn)}</div>
                              <div>Warranty {dayText(d.warrantyEndsOn)}</div>
                              <div>End of life {dayText(d.endOfLifeOn)}</div>
                            </TableCell>
                            <TableCell>
                              <DeviceStateBadge state={d.state} />
                            </TableCell>
                            <TableCell className="text-right">
                              {gaps.length === 0 ? (
                                <span className="text-xs text-muted-foreground">Complete</span>
                              ) : canEdit ? (
                                <button
                                  type="button"
                                  className="inline-flex flex-col items-end gap-1 hover:underline"
                                  title="Fill in what is missing"
                                  onClick={() => setFixingId(d.id)}
                                >
                                  <Badge variant="outline">{gaps.length} missing</Badge>
                                  <span className="max-w-40 text-xs text-muted-foreground">
                                    {GAPS.filter((g) => gaps.includes(g.key))
                                      .map((g) => g.label.toLowerCase())
                                      .join(', ')}
                                  </span>
                                </button>
                              ) : (
                                <Badge
                                  variant="outline"
                                  title={`Missing: ${GAPS.filter((g) => gaps.includes(g.key))
                                    .map((g) => g.label.toLowerCase())
                                    .join(', ')}`}
                                >
                                  {gaps.length} missing
                                </Badge>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </section>
            ))
          )}
        </div>
      )}

      {importing && <ImportRegisterDialog sites={sites} onClose={() => setImporting(false)} />}
      {finding && <FindDevicesDialog onClose={() => setFinding(false)} />}
      {aligning && (
        <AlignDatesDialog sites={sites} rooms={rooms} onClose={() => setAligning(false)} />
      )}
      {fixing && (
        <FixGapsDialog
          key={fixing.id}
          device={fixing}
          nextName={fixNext && fixNext.id !== fixing.id ? fixNext.name : null}
          onSaved={(next) => setFixingId(next && fixNext ? fixNext.id : null)}
          onClose={() => setFixingId(null)}
        />
      )}
      {adding && <AddDeviceDialog sites={sites} rooms={rooms} onClose={() => setAdding(false)} />}
    </PageContainer>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

/** Starting values for the Add device dialog, such as what a network scan found. */
export interface AddDeviceDefaults {
  kind?: 'active' | 'passive';
  name?: string;
  category?: string;
  /** A built-in driver id, or 'pjlink' / 'tcp'. */
  driver?: string;
  host?: string;
  /** Its MAC, when a scan could read it from the gateway's network. */
  mac?: string;
  make?: string;
  model?: string;
  ip?: string;
  /** The site to start on (it can still be changed). */
  siteId?: string;
  /** A monitored device is given this gateway only while it is added to the gateway's own site. */
  gateway?: { id: string; siteId: string };
}

export function AddDeviceDialog({
  sites,
  rooms,
  siteId: fixedSite,
  roomId: fixedRoom,
  defaults,
  onClose,
}: {
  sites: { id: string; name: string }[];
  rooms: { id: string; name: string; siteId: string }[];
  siteId?: string;
  roomId?: string;
  defaults?: AddDeviceDefaults;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const [kind, setKind] = useState<'active' | 'passive'>(defaults?.kind ?? 'passive');
  const [name, setName] = useState(defaults?.name ?? '');
  const [siteId, setSiteId] = useState(
    fixedSite ??
      (defaults?.siteId && sites.some((s) => s.id === defaults.siteId)
        ? defaults.siteId
        : sites[0]?.id) ??
      '',
  );
  const [roomId, setRoomId] = useState(fixedRoom ?? '');
  const [category, setCategory] = useState(defaults?.category ?? 'display');
  const [driver, setDriver] = useState(defaults?.driver ?? 'pjlink');
  const [conn, setConn] = useState<ConnectionDraft>(
    emptyConnection(defaults?.host ? { host: defaults.host } : {}),
  );
  const [ip, setIp] = useState(defaults?.ip ?? '');
  const [address, setAddress] = useState<{
    mode: 'fixed' | 'tracked';
    hostname: string;
    mac: string;
  }>({
    mode: 'fixed',
    hostname: '',
    mac: defaults?.mac ?? '',
  });
  const [make, setMake] = useState(defaults?.make ?? '');
  const [model, setModel] = useState(defaults?.model ?? '');
  const [serial, setSerial] = useState('');
  const [assetTag, setAssetTag] = useState('');
  const siteRooms = rooms.filter((r) => r.siteId === siteId);
  const create = useMutation(
    trpc.device.create.mutationOptions({
      onSuccess: async () => {
        toast.success(kind === 'active' ? 'Device added and will be monitored' : 'Asset recorded');
        await qc.invalidateQueries({ queryKey: trpc.device.list.queryKey() });
        await qc.invalidateQueries({ queryKey: trpc.monitoring.estate.queryKey() });
        onClose();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const slots = connectionSlots(controlFor(driver));
  const valid =
    name.trim().length > 0 && siteId && (kind === 'passive' || !connectionMissing(slots, conn));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a device</DialogTitle>
          <DialogDescription>
            A monitored device is polled through its driver. A recorded one is an asset only: it is
            kept in the register but never shown online or offline.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <SimpleSelect
            value={kind}
            onValueChange={(v) => setKind(v as 'active' | 'passive')}
            options={[
              { value: 'passive', label: 'Recorded only (asset)' },
              { value: 'active', label: 'Monitored (networked, has a driver)' },
            ]}
          />
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Lectern laptop"
              maxLength={80}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Site">
              <SimpleSelect
                value={siteId}
                disabled={!!fixedSite}
                onValueChange={(v) => {
                  setSiteId(v);
                  setRoomId('');
                }}
                options={sites.map((s) => ({ value: s.id, label: s.name }))}
              />
            </Field>
            <Field label="Room">
              <SimpleSelect
                value={roomId || '__none'}
                disabled={!!fixedRoom}
                onValueChange={(v) => setRoomId(v === '__none' ? '' : v)}
                options={[
                  { value: '__none', label: 'Not in a room' },
                  ...siteRooms.map((r) => ({ value: r.id, label: r.name })),
                ]}
              />
            </Field>
          </div>
          <Field label="Category">
            <SimpleSelect
              value={category}
              onValueChange={(v) => {
                setCategory(v);
                // Keep the driver only if it still suits the new category.
                if (!driverOptionsFor(v).some((o) => o.value === driver)) {
                  setDriver(driverOptionsFor(v)[0]?.value ?? 'pjlink');
                  setConn(emptyConnection());
                }
              }}
              options={CATEGORY_OPTIONS}
            />
          </Field>
          {kind === 'active' && (
            <div className="space-y-3">
              <Field label="Driver">
                <SimpleSelect
                  value={driver}
                  onValueChange={(v) => {
                    setDriver(v);
                    setConn(emptyConnection());
                  }}
                  options={driverOptionsFor(category)}
                />
              </Field>
              <ConnectionFields slots={slots} draft={conn} onChange={setConn} />
              <AddressTrackingFields {...address} onChange={setAddress} />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Make">
              <Input value={make} onChange={(e) => setMake(e.target.value)} maxLength={100} />
            </Field>
            <Field label="Model">
              <Input value={model} onChange={(e) => setModel(e.target.value)} maxLength={100} />
            </Field>
            {kind === 'passive' && (
              <Field label="IP address">
                <Input value={ip} onChange={(e) => setIp(e.target.value)} maxLength={80} />
              </Field>
            )}
            <Field label="Serial number">
              <Input value={serial} onChange={(e) => setSerial(e.target.value)} maxLength={100} />
            </Field>
            <Field label="Asset tag">
              <Input
                value={assetTag}
                onChange={(e) => setAssetTag(e.target.value)}
                maxLength={80}
              />
            </Field>
          </div>
          {kind === 'active' && (
            <p className="text-xs text-muted-foreground">
              Anything left blank that the device reports itself (serial, model, firmware) fills in
              once a gateway is polling it. Connection settings can be changed later on the device
              page.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid || create.isPending}
            onClick={() =>
              create.mutate({
                orgId,
                siteId,
                kind,
                name: name.trim(),
                category: category as never,
                roomId: roomId || null,
                ...(kind === 'active'
                  ? {
                      control: controlFor(driver),
                      values: connectionPatch(slots, conn).values,
                      secrets: connectionPatch(slots, conn).secrets,
                      credentialSetId: connectionPatch(slots, conn).credentialSetId,
                      addressMode: address.mode,
                      hostname: address.mode === 'tracked' ? address.hostname.trim() || null : null,
                      mac: address.mac.trim() || null,
                      ...(defaults?.gateway && defaults.gateway.siteId === siteId
                        ? { gatewayId: defaults.gateway.id }
                        : {}),
                    }
                  : { ip: ip.trim() || null }),
                make: make || null,
                model: model || null,
                serial: serial || null,
                assetTag: assetTag || null,
              })
            }
          >
            Add device
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
