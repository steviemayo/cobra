'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Activity, Search } from 'lucide-react';
import { assetCategoryLabel, type DeviceLiveState } from '@kestrel/model';
import { EmptyState } from '@/components/common/empty-state';
import { INCIDENT_KIND_LABEL, SeverityPill, dateTime } from '@/components/common/health';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { GatewayStatus } from '@/components/common/status';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
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
import { plural, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import { DeviceStateBadge } from './device-detail';

const ORDER: Record<DeviceLiveState, number> = { offline: 0, unknown: 1, online: 2, none: 3 };

/** Every monitored device and how it is doing right now, worst first, with the gateways beside them. */
export function MonitoringBoardView() {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const devices = useQuery({
    ...trpc.device.list.queryOptions({ orgId }),
    refetchInterval: 15_000,
  });
  const gateways = useQuery({
    ...trpc.gateway.list.queryOptions({ orgId }),
    refetchInterval: 15_000,
  });
  const incidents = useQuery({
    ...trpc.monitoring.incidents.queryOptions({ orgId, status: 'open', limit: 8 }),
    refetchInterval: 15_000,
    retry: false,
  });
  const [search, setSearch] = useState('');
  const [state, setState] = useState('');
  const active = useMemo(
    () => (devices.data ?? []).filter((d) => d.kind === 'active'),
    [devices.data],
  );
  const counts = useMemo(() => {
    const c = { online: 0, offline: 0, unknown: 0 };
    for (const d of active)
      if (d.state === 'online' || d.state === 'offline' || d.state === 'unknown') c[d.state]++;
    return c;
  }, [active]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return active
      .filter((d) => !state || d.state === state)
      .filter(
        (d) =>
          !q ||
          [d.name, d.roomName, d.driver, d.gatewayName, d.model]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(q)),
      )
      .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
  }, [active, search, state]);

  return (
    <PageContainer>
      <PageHeader
        title="Monitoring"
        description="Every monitored device and gateway, worst first. It refreshes by itself."
      />
      {devices.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : devices.isError ? (
        <p className="text-sm text-destructive">{devices.error.message}</p>
      ) : active.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="Nothing is monitored yet"
          description="Add a networked device with a driver to a room and a gateway will start watching it."
        />
      ) : (
        <>
          <div className="grid grid-cols-3 divide-x overflow-hidden rounded-lg border">
            {(
              [
                ['Online', counts.online, ''],
                ['Offline', counts.offline, counts.offline ? 'text-destructive' : ''],
                ['Unknown', counts.unknown, counts.unknown ? 'text-warning' : ''],
              ] as const
            ).map(([label, n, tone]) => (
              <button
                key={label}
                type="button"
                className="px-4 py-3 text-left transition-colors hover:bg-muted/50"
                onClick={() => setState(state === label.toLowerCase() ? '' : label.toLowerCase())}
              >
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className={cn('tabular mt-1 text-2xl font-semibold', tone)}>{n}</div>
                {label === 'Unknown' && (
                  <div className="text-xs text-muted-foreground">
                    Gateway silent or not heard yet
                  </div>
                )}
              </button>
            ))}
          </div>

          {(incidents.data?.length ?? 0) > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-medium">Open incidents</h2>
              <ul className="divide-y rounded-lg border">
                {incidents.data!.map((i) => (
                  <li
                    key={i.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm"
                  >
                    <span>
                      <Link
                        href={orgPath(orgId, '/incidents')}
                        className="font-medium hover:underline"
                      >
                        {i.title}
                      </Link>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {INCIDENT_KIND_LABEL[i.kind] ?? i.kind}
                      </span>
                    </span>
                    <span className="flex items-center gap-3 text-xs text-muted-foreground">
                      <SeverityPill severity={i.severity} />
                      {dateTime(i.openedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-48 flex-1 sm:max-w-64">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search devices, rooms, gateways"
                className="h-8 pl-8"
                aria-label="Search devices"
              />
            </div>
            <SimpleSelect
              size="sm"
              className="w-36"
              value={state}
              placeholder="Any state"
              onValueChange={(v) => setState(v === '__all' ? '' : v)}
              options={[
                { value: '__all', label: 'Any state' },
                { value: 'online', label: 'Online' },
                { value: 'offline', label: 'Offline' },
                { value: 'unknown', label: 'Unknown' },
              ]}
            />
            <span className="ml-auto text-xs text-muted-foreground">
              {plural(rows.length, 'device')}
            </span>
          </div>

          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>State</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>Room</TableHead>
                  <TableHead>Gateway</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead className="text-right">Last heard</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <DeviceStateBadge state={d.state} />
                      {d.since && d.state !== 'unknown' && (
                        <div className="text-xs text-muted-foreground">
                          since {timeAgo(d.since)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-medium">
                      <Link href={orgPath(orgId, `/devices/${d.id}`)} className="hover:underline">
                        {d.name}
                      </Link>
                      <div className="text-xs font-normal text-muted-foreground">
                        {assetCategoryLabel(d.category)}
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
                    <TableCell>
                      {d.gatewayName ? (
                        <GatewayStatus
                          gateway={{ name: d.gatewayName, status: d.gatewayStatus ?? 'pending' }}
                        />
                      ) : (
                        <Badge variant="outline">No gateway</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {d.driver ?? '–'}
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      {d.lastSeenAt ? timeAgo(d.lastSeenAt) : 'never'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">Gateways</h2>
            {gateways.isPending ? (
              <Skeleton className="h-12 w-full" />
            ) : (
              <ul className="divide-y rounded-lg border text-sm">
                {(gateways.data ?? []).map((g) => (
                  <li
                    key={g.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
                  >
                    <GatewayStatus gateway={{ name: g.name, status: g.status }} />
                    <span className="text-xs text-muted-foreground">
                      {plural(active.filter((d) => d.gatewayId === g.id).length, 'device')} ·{' '}
                      {g.lastSeenAt ? `heard ${timeAgo(g.lastSeenAt)}` : 'not connected yet'}
                      {g.version ? ` · v${g.version}` : ''}
                    </span>
                  </li>
                ))}
                {(gateways.data ?? []).length === 0 && (
                  <li className="px-4 py-3 text-muted-foreground">No gateways yet.</li>
                )}
              </ul>
            )}
          </section>
        </>
      )}
    </PageContainer>
  );
}
