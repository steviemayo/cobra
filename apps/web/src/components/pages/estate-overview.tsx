'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Building2, DoorOpen, Package, Plus, Search } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { HEALTH_ORDER, HealthPill } from '@/components/common/health';
import { AlertBadges, AlertControls, MutedBell } from '@/components/common/alert-controls';
import { PageContainer, PageHeader, Stagger, StaggerItem } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { useDialogs } from '@/components/shell/dialogs';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
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
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Estate = RouterOutputs['monitoring']['estate'];
type EstateRoom = Estate['rooms'][number];

/** The gateway state worth showing for a room: the worst of the gateways that poll its devices. */
function GatewayCell({ room }: { room: EstateRoom }) {
  if (room.gateways.length === 0)
    return (
      <span className="text-sm text-muted-foreground">
        {room.devices.active ? 'Unassigned' : '–'}
      </span>
    );
  const tone =
    room.gatewayStatus === 'online'
      ? 'bg-success'
      : room.gatewayStatus === 'offline'
        ? 'bg-destructive'
        : 'bg-warning';
  const first = room.gateways[0]!;
  const offline = room.gateways.filter((g) => g.status === 'offline').length;
  return (
    <span
      className="inline-flex items-center gap-2 text-sm"
      title={room.gateways.map((g) => `${g.name}: ${g.status}`).join('\n')}
    >
      <span aria-hidden className={cn('size-2 rounded-full', tone)} />
      {room.gateways.length === 1
        ? first.name
        : `${room.gateways.length} gateways${offline ? `, ${offline} offline` : ''}`}
    </span>
  );
}

function DevicesCell({ room }: { room: EstateRoom }) {
  const { active, online, unknown, passive } = room.devices;
  if (active === 0 && passive === 0) return <span className="text-muted-foreground">–</span>;
  return (
    <span className="tabular text-sm">
      {active > 0 ? (
        <>
          {online} of {active} online
          {unknown > 0 && <span className="text-muted-foreground">, {unknown} unknown</span>}
        </>
      ) : (
        <span className="text-muted-foreground">Nothing monitored</span>
      )}
      {passive > 0 && <span className="text-muted-foreground"> · {passive} recorded</span>}
    </span>
  );
}

function Kpi({
  label,
  value,
  hint,
  tone,
  onClick,
  href,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'bad' | 'warn' | 'good';
  onClick?: () => void;
  href?: string;
}) {
  const body = (
    <>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          'tabular mt-1 text-2xl font-semibold tracking-tight',
          tone === 'bad' && 'text-destructive',
          tone === 'warn' && 'text-warning',
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</div>}
    </>
  );
  const cls =
    'block px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none';
  if (href)
    return (
      <Link href={href} className={cls}>
        {body}
      </Link>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} className={cn(cls, 'w-full')}>
        {body}
      </button>
    );
  return <div className="px-4 py-3">{body}</div>;
}

type StatusFilter = 'all' | 'attention' | 'down' | 'unknown' | 'healthy';

export function EstateOverviewView() {
  const trpc = useTRPC();
  const router = useRouter();
  const { org, orgId, canEdit } = useOrg();
  const { openNewSite, openNewRoom } = useDialogs();
  const estate = useQuery({
    ...trpc.monitoring.estate.queryOptions({ orgId }),
    staleTime: 15_000,
    refetchInterval: 15_000,
    retry: false,
  });
  const [siteId, setSiteId] = useState('');
  const [areaId, setAreaId] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');

  const data = estate.data;
  const areaOptions = useMemo(
    () => (data?.areas ?? []).filter((a) => !siteId || a.siteId === siteId),
    [data, siteId],
  );
  // An area holds its own rooms and those of the areas inside it.
  const areaIds = useMemo(() => {
    if (!areaId || !data) return null;
    const ids = new Set([areaId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const a of data.areas)
        if (a.parentId && ids.has(a.parentId) && !ids.has(a.id)) {
          ids.add(a.id);
          grew = true;
        }
    }
    return ids;
  }, [areaId, data]);

  const rooms = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.rooms ?? [])
      .filter((r) => !siteId || r.siteId === siteId)
      .filter((r) => !areaIds || (r.areaId !== null && areaIds.has(r.areaId)))
      .filter((r) => {
        if (status === 'all') return true;
        if (status === 'attention') return r.openIncidents > 0;
        return r.health.level === status;
      })
      .filter(
        (r) =>
          !q ||
          r.name.toLowerCase().includes(q) ||
          r.siteName.toLowerCase().includes(q) ||
          r.areaPath.toLowerCase().includes(q) ||
          r.tags.some((t) => t.toLowerCase().includes(q)),
      )
      .sort(
        (a, b) =>
          HEALTH_ORDER[a.health.level] - HEALTH_ORDER[b.health.level] ||
          a.name.localeCompare(b.name),
      );
  }, [data, siteId, areaIds, status, search]);

  const k = data?.kpis;
  const orgAlerts = {
    mutedBy: data?.orgMuted.muted ? ('org' as const) : null,
    mutedUntil: data?.orgMuted.until ?? null,
    inMaintenance: data?.orgMuted.inMaintenance ?? false,
  };
  const showInUse = (data?.rooms ?? []).some((r) => r.inUse !== null);

  return (
    <PageContainer>
      <PageHeader
        title="Overview"
        description={`Everything across ${org.name}.`}
        meta={
          <AlertBadges state={orgAlerts} />
        }
        actions={
          canEdit && (
            <>
              <AlertControls scope="org" state={orgAlerts} />
              <Button variant="outline" size="sm" onClick={openNewSite}>
                <Building2 data-icon="inline-start" /> New site
              </Button>
              <Link
                href={orgPath(orgId, '/assets')}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[0.8rem] font-medium hover:bg-muted"
              >
                <Package className="size-3.5" /> Assets
              </Link>
              <Button size="sm" onClick={() => openNewRoom()}>
                <Plus data-icon="inline-start" /> New room
              </Button>
            </>
          )
        }
      />

      {estate.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : estate.isError || !data || !k ? (
        <EmptyState
          icon={Building2}
          title="Live status is not available"
          description="Your plan does not include monitoring, or the estate could not be read."
        />
      ) : data.sites.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No sites yet"
          description="A site is a building or campus. Add one, then its rooms and devices."
          action={canEdit ? <Button onClick={openNewSite}>Create a site</Button> : undefined}
        />
      ) : (
        <Stagger className="space-y-6">
          <StaggerItem>
            <div className="grid grid-cols-2 divide-x divide-y overflow-hidden rounded-lg border sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-5 sm:[&>*:nth-child(n+4)]:border-t">
              <Kpi
                label="Live incidents"
                value={k.liveIncidents}
                tone={k.criticalIncidents > 0 ? 'bad' : k.liveIncidents > 0 ? 'warn' : undefined}
                hint={
                  k.liveIncidents ? `${k.criticalIncidents} critical` : 'Nothing needs attention'
                }
                href={orgPath(orgId, '/incidents')}
              />
              <Kpi
                label="Rooms needing attention"
                value={k.roomsNeedingAttention}
                tone={k.roomsNeedingAttention > 0 ? 'warn' : undefined}
                hint={`of ${plural(k.rooms, 'room')}`}
                onClick={() => setStatus(status === 'attention' ? 'all' : 'attention')}
              />
              <Kpi
                label="Rooms online"
                value={k.roomsMonitored ? `${k.roomsOnline} of ${k.roomsMonitored}` : '–'}
                hint={
                  k.roomsMonitored < k.rooms
                    ? `${k.rooms - k.roomsMonitored} not monitored`
                    : 'All rooms monitored'
                }
                onClick={() => setStatus(status === 'healthy' ? 'all' : 'healthy')}
              />
              <Kpi
                label="Devices online"
                value={k.devicesActive ? `${k.devicesOnline} of ${k.devicesActive}` : '–'}
                hint={
                  k.devicesUnknown
                    ? `${k.devicesUnknown} unknown (gateway silent)`
                    : `${k.devicesPassive} recorded assets`
                }
                href={orgPath(orgId, '/assets')}
              />
              <Kpi
                label="Gateways online"
                value={k.gateways ? `${k.gatewaysOnline} of ${k.gateways}` : '–'}
                tone={k.gateways > k.gatewaysOnline ? 'warn' : undefined}
                href={orgPath(orgId, '/gateways')}
              />
              <Kpi
                label="Rooms in use now"
                value={k.roomsInUse ?? '–'}
                hint={k.roomsInUse === null ? 'Set what counts as in use' : undefined}
              />
              <Kpi
                label="Configuration drift"
                value={k.driftCount ?? '–'}
                hint={k.driftCount === null ? 'Not set up yet' : undefined}
              />
              <Kpi
                label="Maintenance due"
                value={k.pmOverdue + k.pmDueSoon}
                tone={k.pmOverdue > 0 ? 'bad' : k.pmDueSoon > 0 ? 'warn' : undefined}
                hint={
                  k.pmOverdue || k.pmDueSoon
                    ? `${k.pmOverdue} overdue, ${k.pmDueSoon} due soon`
                    : 'Nothing due'
                }
                href={orgPath(orgId, '/pm/schedule')}
              />
              <Kpi label="Open tickets" value={k.openTickets} href={orgPath(orgId, '/tickets')} />
            </div>
          </StaggerItem>

          <StaggerItem className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-48 flex-1 sm:max-w-64">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search rooms, areas, tags"
                  className="h-8 pl-8"
                  aria-label="Search rooms"
                />
              </div>
              <SimpleSelect
                size="sm"
                className="w-40"
                value={siteId}
                placeholder="All sites"
                onValueChange={(v) => {
                  setSiteId(v === '__all' ? '' : v);
                  setAreaId('');
                }}
                options={[
                  { value: '__all', label: 'All sites' },
                  ...data.sites.map((s) => ({ value: s.id, label: s.name })),
                ]}
              />
              {areaOptions.length > 0 && (
                <SimpleSelect
                  size="sm"
                  className="w-44"
                  value={areaId}
                  placeholder="All areas"
                  onValueChange={(v) => setAreaId(v === '__all' ? '' : v)}
                  options={[
                    { value: '__all', label: 'All areas' },
                    ...areaOptions.map((a) => ({
                      value: a.id,
                      label: `${a.label ? `${a.label}: ` : ''}${a.name}`,
                    })),
                  ]}
                />
              )}
              <SimpleSelect
                size="sm"
                className="w-40"
                value={status}
                onValueChange={(v) => setStatus(v as StatusFilter)}
                options={[
                  { value: 'all', label: 'Any status' },
                  { value: 'attention', label: 'Needs attention' },
                  { value: 'down', label: 'Down' },
                  { value: 'unknown', label: 'Unknown' },
                  { value: 'healthy', label: 'Healthy' },
                ]}
              />
              <span className="ml-auto text-xs text-muted-foreground">
                {plural(rooms.length, 'room')}
              </span>
            </div>

            {rooms.length === 0 ? (
              <EmptyState
                icon={DoorOpen}
                title={data.rooms.length === 0 ? 'No rooms yet' : 'No rooms match'}
                description={
                  data.rooms.length === 0
                    ? 'Add a room, then put its devices in it.'
                    : 'Try clearing a filter.'
                }
                action={
                  data.rooms.length === 0 && canEdit ? (
                    <Button onClick={() => openNewRoom()}>Add a room</Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead>Live status</TableHead>
                      <TableHead>Room</TableHead>
                      <TableHead>Site / area</TableHead>
                      <TableHead>Devices</TableHead>
                      <TableHead>Gateway</TableHead>
                      {showInUse && <TableHead>In use</TableHead>}
                      <TableHead className="text-right">Incidents</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rooms.map((r) => {
                      const href = orgPath(orgId, `/rooms/${r.id}`);
                      return (
                        <TableRow
                          key={r.id}
                          className="cursor-pointer"
                          onClick={() => router.push(href)}
                        >
                          <TableCell>
                            <HealthPill level={r.health.level} reasons={r.health.reasons} />
                          </TableCell>
                          <TableCell className="font-medium">
                            <Link
                              href={href}
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex flex-wrap items-center gap-2 hover:underline"
                            >
                              {r.name}
                              {r.kind === 'staging' && <Badge variant="secondary">Staging</Badge>}
                              {r.mutedBy && <MutedBell by={r.mutedBy} until={r.mutedUntil} />}
                              {r.tags.slice(0, 2).map((t) => (
                                <Badge key={t} variant="outline" className="font-normal">
                                  {t}
                                </Badge>
                              ))}
                            </Link>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {r.siteName}
                            {r.areaPath && <span className="text-xs"> / {r.areaPath}</span>}
                          </TableCell>
                          <TableCell>
                            <DevicesCell room={r} />
                          </TableCell>
                          <TableCell>
                            <GatewayCell room={r} />
                          </TableCell>
                          {showInUse && (
                            <TableCell className="text-sm">
                              {r.inUse === null ? '–' : r.inUse ? 'In use' : 'Empty'}
                            </TableCell>
                          )}
                          <TableCell className="tabular text-right">
                            {r.openIncidents > 0 ? (
                              <span
                                className={cn(
                                  r.worstSeverity === 'critical'
                                    ? 'text-destructive'
                                    : 'text-warning',
                                )}
                              >
                                {r.openIncidents}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">0</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </StaggerItem>
        </Stagger>
      )}
    </PageContainer>
  );
}
