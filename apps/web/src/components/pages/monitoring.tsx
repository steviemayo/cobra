'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import {
  HEALTH_ORDER,
  HealthPill,
  INCIDENT_KIND_LABEL,
  OnlineDot,
  SeverityPill,
  dateTime,
  type HealthLevel,
} from '@/components/common/health';
import { PageContainer, PageHeader, Stagger, StaggerItem } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { plural, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';

const LIVE_MS = 5_000;

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <StaggerItem className="rounded-lg border px-4 py-3">
      <div className={cn('text-2xl font-semibold tabular-nums', tone)}>{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
    </StaggerItem>
  );
}

function GatewayDot({ status }: { status: 'pending' | 'online' | 'offline' | null }) {
  const tone =
    status === 'online' ? 'bg-success' : status === 'offline' ? 'bg-destructive' : 'bg-warning';
  return <span aria-hidden className={cn('size-2 shrink-0 rounded-full', tone)} />;
}

/** Live status of every room and gateway in the organisation, refreshed every few seconds. */
export function MonitoringView() {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [site, setSite] = useState('all');
  const [deviceStatus, setDeviceStatus] = useState<'all' | 'online' | 'offline'>('all');
  const overview = useQuery({
    ...trpc.monitoring.overview.queryOptions({ orgId }),
    refetchInterval: LIVE_MS,
  });
  const incidents = useQuery({
    ...trpc.monitoring.incidents.queryOptions({ orgId, status: 'open', limit: 5 }),
    refetchInterval: LIVE_MS,
  });
  const devices = useQuery({
    ...trpc.monitoring.devices.queryOptions({ orgId }),
    refetchInterval: LIVE_MS,
  });
  // The last day's worth of incidents, open or resolved: "what has actually gone wrong lately",
  // not just what's still open right now.
  const recentFaults = useQuery({
    ...trpc.monitoring.incidents.queryOptions({ orgId, status: 'all', limit: 50 }),
    refetchInterval: LIVE_MS,
    select: (rows) =>
      rows.filter((i) => Date.now() - new Date(i.openedAt).getTime() < 24 * 3_600_000),
  });

  const data = overview.data;
  const sites = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of data?.rooms ?? []) map.set(r.siteId, r.siteName);
    return [...map].map(([value, label]) => ({ value, label }));
  }, [data]);
  const rooms = useMemo(
    () =>
      (data?.rooms ?? [])
        .filter((r) => site === 'all' || r.siteId === site)
        .sort(
          (a, b) =>
            HEALTH_ORDER[a.health.level] - HEALTH_ORDER[b.health.level] ||
            a.name.localeCompare(b.name),
        ),
    [data, site],
  );
  const count = (level: HealthLevel) =>
    (data?.rooms ?? []).filter((r) => r.health.level === level).length;
  const deviceRows = useMemo(
    () =>
      (devices.data ?? [])
        .filter((d) => site === 'all' || d.siteId === site)
        .filter((d) => deviceStatus === 'all' || (deviceStatus === 'online' ? d.online : !d.online))
        .sort((a, b) => Number(a.online) - Number(b.online) || a.name.localeCompare(b.name)),
    [devices.data, site, deviceStatus],
  );
  const devicesOffline = (devices.data ?? []).filter((d) => !d.online).length;

  return (
    <PageContainer>
      <PageHeader
        title="Monitoring"
        description="How every room and gateway is doing right now."
        meta={
          data && (
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-success" />
              Live, updated {timeAgo(new Date(overview.dataUpdatedAt))}
            </span>
          )
        }
        actions={
          sites.length > 1 && (
            <SimpleSelect
              size="sm"
              className="w-44"
              value={site}
              onValueChange={setSite}
              options={[{ value: 'all', label: 'All sites' }, ...sites]}
            />
          )
        }
      />

      {overview.isPending ? (
        <div className="space-y-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : !data || (data.rooms.length === 0 && data.gateways.length === 0) ? (
        <EmptyState
          icon={Activity}
          title="Nothing to monitor yet"
          description="Add a gateway and deploy a room to it. Its status shows up here as soon as it reports in."
        />
      ) : (
        <>
          <Stagger className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Healthy rooms" value={count('healthy')} tone="text-success" />
            <Stat
              label="Need attention"
              value={count('degraded') + count('down')}
              tone={count('degraded') + count('down') ? 'text-destructive' : undefined}
            />
            <Stat label="Status unknown" value={count('unknown')} />
            <Stat
              label="Open incidents"
              value={data.incidents.open}
              tone={data.incidents.critical ? 'text-destructive' : undefined}
            />
            <Stat
              label="Devices offline"
              value={devicesOffline}
              tone={devicesOffline ? 'text-destructive' : undefined}
            />
          </Stagger>

          {incidents.data && incidents.data.length > 0 && (
            <section className="overflow-hidden rounded-lg border">
              <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2.5">
                <h2 className="flex items-center gap-2 text-sm font-medium">
                  <AlertTriangle className="size-4 text-warning" /> Open incidents
                </h2>
                <Link
                  href={orgPath(orgId, '/incidents')}
                  className="text-sm text-muted-foreground hover:text-foreground hover:underline"
                >
                  View all
                </Link>
              </div>
              <ul className="divide-y">
                {incidents.data.map((i) => (
                  <li
                    key={i.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{i.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {INCIDENT_KIND_LABEL[i.kind] ?? i.kind}
                        {i.roomName ? ` · ${i.roomName}` : ''} · {timeAgo(i.openedAt)}
                      </div>
                    </div>
                    <SeverityPill severity={i.severity} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {recentFaults.data && recentFaults.data.length > 0 && (
            <section className="overflow-hidden rounded-lg border">
              <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2.5">
                <h2 className="text-sm font-medium">Recent faults</h2>
                <Link
                  href={orgPath(orgId, '/incidents')}
                  className="text-sm text-muted-foreground hover:text-foreground hover:underline"
                >
                  View all
                </Link>
              </div>
              <ul className="divide-y">
                {recentFaults.data.map((i) => (
                  <li
                    key={i.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{i.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {INCIDENT_KIND_LABEL[i.kind] ?? i.kind}
                        {i.roomName ? ` · ${i.roomName}` : ''} ·{' '}
                        {i.status === 'open'
                          ? `opened ${timeAgo(i.openedAt)}`
                          : `resolved ${i.resolvedAt ? dateTime(i.resolvedAt) : ''}`}
                      </div>
                    </div>
                    <SeverityPill severity={i.severity} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium">Devices</h2>
              <SimpleSelect
                size="sm"
                className="w-36"
                value={deviceStatus}
                onValueChange={(v) => setDeviceStatus(v as typeof deviceStatus)}
                options={[
                  { value: 'all', label: 'All devices' },
                  { value: 'offline', label: 'Offline only' },
                  { value: 'online', label: 'Online only' },
                ]}
              />
            </div>
            {deviceRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {deviceStatus === 'all' ? 'No device status yet.' : 'No devices match this filter.'}
              </p>
            ) : (
              <div className="overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead>Device</TableHead>
                      <TableHead>Room</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Since</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deviceRows.map((d) => (
                      <TableRow key={`${d.roomId}:${d.deviceId}`}>
                        <TableCell className="font-medium">{d.name}</TableCell>
                        <TableCell>
                          <Link
                            href={orgPath(orgId, `/rooms/${d.roomId}/monitoring`)}
                            className="text-muted-foreground hover:text-foreground hover:underline"
                          >
                            {d.roomName}
                          </Link>
                          <div className="text-xs text-muted-foreground">{d.siteName}</div>
                        </TableCell>
                        <TableCell>
                          <span className="inline-flex items-center gap-2 text-sm">
                            <OnlineDot online={d.online} />
                            {d.online ? 'Online' : 'Offline'}
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {timeAgo(d.since)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">Rooms</h2>
            {rooms.length === 0 ? (
              <p className="text-sm text-muted-foreground">No rooms at this site.</p>
            ) : (
              <div className="overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead>Room</TableHead>
                      <TableHead>Health</TableHead>
                      <TableHead>Devices</TableHead>
                      <TableHead>Gateway</TableHead>
                      <TableHead className="text-right">Last report</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rooms.map((r) => (
                      <TableRow key={r.id} className="cursor-pointer">
                        <TableCell>
                          <Link
                            href={orgPath(orgId, `/rooms/${r.id}/monitoring`)}
                            className="font-medium hover:underline"
                          >
                            {r.name}
                          </Link>
                          <div className="text-xs text-muted-foreground">{r.siteName}</div>
                        </TableCell>
                        <TableCell>
                          <HealthPill level={r.health.level} reasons={r.health.reasons} />
                          {r.health.reasons[0] && (
                            <div className="text-xs text-muted-foreground">
                              {r.health.reasons[0]}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums text-muted-foreground">
                          {r.devices.total === 0
                            ? '–'
                            : `${r.devices.online} of ${r.devices.total} online`}
                        </TableCell>
                        <TableCell>
                          {r.gatewayName ? (
                            <span className="inline-flex items-center gap-2 text-sm">
                              <GatewayDot status={r.gatewayStatus} />
                              {r.gatewayName}
                            </span>
                          ) : (
                            <span className="text-sm text-muted-foreground">Unassigned</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {r.reportedAt ? timeAgo(r.reportedAt) : 'Never'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">Gateways</h2>
            {data.gateways.length === 0 ? (
              <p className="text-sm text-muted-foreground">No gateways yet.</p>
            ) : (
              <div className="overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead>Gateway</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Rooms</TableHead>
                      <TableHead>Version</TableHead>
                      <TableHead className="text-right">Last seen</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.gateways.map((g) => (
                      <TableRow key={g.id}>
                        <TableCell>
                          <div className="font-medium">{g.name}</div>
                          <div className="text-xs text-muted-foreground">{g.siteName}</div>
                        </TableCell>
                        <TableCell>
                          <span className="inline-flex items-center gap-2 text-sm">
                            <GatewayDot status={g.status} />
                            {g.status === 'online'
                              ? 'Online'
                              : g.status === 'offline'
                                ? 'Offline'
                                : 'Waiting to enrol'}
                          </span>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {plural(g.roomCount, 'room')}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{g.version ?? '–'}</TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {g.lastSeenAt ? timeAgo(g.lastSeenAt) : 'Never'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>
        </>
      )}
    </PageContainer>
  );
}
