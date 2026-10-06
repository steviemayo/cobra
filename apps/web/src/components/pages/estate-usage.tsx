'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, ChevronDown, Lightbulb } from 'lucide-react';
import { USAGE_KIND_LABEL, type UsageKind } from '@kestrel/model';
import { minutesLabel } from '@/components/common/usage-charts';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
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
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type UsageRow = RouterOutputs['roomUsage']['estate']['rows'][number];

/** Below this share of working hours a room is flagged as underused. */
const UNDERUSED = 0.1;

const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);

/** The mean utilisation of the rooms that have one, or null when none do. */
const averageOf = (rows: UsageRow[]) => {
  const measured = rows.filter((r) => r.utilisation !== null);
  return measured.length
    ? measured.reduce((n, r) => n + r.utilisation!, 0) / measured.length
    : null;
};

function Kpi({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tabular mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** Totals for the rooms in view. */
function UsageSummary({ rows }: { rows: UsageRow[] }) {
  const sessions = rows.reduce((n, r) => n + r.sessions, 0);
  const minutes = rows.reduce((n, r) => n + r.minutes, 0);
  const afterHours = rows.reduce((n, r) => n + r.afterHoursMinutes, 0);
  const watched = rows.filter((r) => r.inUseNow !== null);
  const inUse = watched.filter((r) => r.inUseNow).length;
  return (
    <div className="grid grid-cols-2 divide-x divide-y overflow-hidden rounded-lg border sm:grid-cols-5 sm:divide-y-0">
      <Kpi
        label="Average utilisation"
        value={pct(averageOf(rows))}
        hint={`across ${plural(rows.length, 'room')}`}
      />
      <Kpi label="Sessions" value={sessions} />
      <Kpi label="Time in use" value={minutesLabel(minutes)} hint="in total" />
      <Kpi
        label="Out of hours"
        value={minutesLabel(afterHours)}
        hint={minutes ? `${Math.round((afterHours / minutes) * 100)}% of time in use` : undefined}
      />
      <Kpi
        label="In use now"
        value={watched.length ? `${inUse} of ${watched.length}` : '–'}
        hint="rooms"
      />
    </div>
  );
}

/** Utilisation as a bar, so the ranking reads at a glance. */
function UtilisationBar({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">–</span>;
  const low = value < UNDERUSED;
  return (
    <div className="flex items-center justify-end gap-2.5">
      {low && (
        <Badge variant="outline" className="text-muted-foreground">
          Underused
        </Badge>
      )}
      <div
        className="h-2 w-28 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${pct(value)} utilisation`}
      >
        <div
          className={low ? 'h-full bg-muted-foreground/50' : 'h-full bg-brand'}
          style={{ width: `${Math.max(2, Math.min(100, Math.round(value * 100)))}%` }}
        />
      </div>
      <span className="tabular w-10 text-right text-sm font-semibold">{pct(value)}</span>
    </div>
  );
}

/** The rooms of one view, with the site each is at. */
function UsageTable({ rows }: { rows: UsageRow[] }) {
  const { orgId } = useOrg();
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead>Room</TableHead>
            <TableHead>Site</TableHead>
            <TableHead className="text-right">Utilisation</TableHead>
            <TableHead className="text-right">Sessions</TableHead>
            <TableHead className="text-right">Average</TableHead>
            <TableHead className="text-right">In use</TableHead>
            <TableHead className="text-right">Out of hours</TableHead>
            <TableHead>Now</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.roomId}>
              <TableCell className="font-medium">
                <Link href={orgPath(orgId, `/rooms/${r.roomId}/usage`)} className="hover:underline">
                  {r.roomName}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">{r.siteName ?? '–'}</TableCell>
              <TableCell>
                <UtilisationBar value={r.utilisation} />
              </TableCell>
              <TableCell className="tabular text-right text-muted-foreground">
                {r.sessions}
              </TableCell>
              <TableCell className="tabular text-right text-muted-foreground">
                {r.sessions ? minutesLabel(r.averageMinutes) : '–'}
              </TableCell>
              <TableCell className="tabular text-right text-muted-foreground">
                {minutesLabel(r.minutes)}
              </TableCell>
              <TableCell className="tabular text-right text-muted-foreground">
                {minutesLabel(r.afterHoursMinutes)}
              </TableCell>
              <TableCell>
                {r.inUseNow === null ? (
                  <span className="text-muted-foreground">–</span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span
                      className={`size-2 rounded-full ${r.inUseNow ? 'bg-success' : 'bg-muted-foreground/30'}`}
                    />
                    {r.inUseNow ? 'In use' : 'Empty'}
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** How every monitored room is used, ranked, with what stands out. */
export function EstateUsageView() {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [kind, setKind] = useState<UsageKind>('av');
  const [days, setDays] = useState(30);
  const [showInsights, setShowInsights] = useState(false);
  // The whole organisation, grouped site by site, or one site.
  const [view, setView] = useState<string>('all');
  const usage = useQuery({
    ...trpc.roomUsage.estate.queryOptions({ orgId, kind, days }),
    refetchInterval: 60_000,
    retry: false,
  });
  const rows = [...(usage.data?.rows ?? [])].sort(
    (a, b) => (b.utilisation ?? -1) - (a.utilisation ?? -1),
  );
  const sites = [
    ...new Map(rows.flatMap((r) => (r.siteId ? [[r.siteId, r.siteName ?? 'A site']] : []))),
  ]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // A site that has gone (or has no rooms in view) falls back to the whole organisation.
  const oneSite = sites.some((x) => x.id === view);
  const shown = oneSite ? rows.filter((r) => r.siteId === view) : rows;
  const shownRooms = new Set(shown.map((r) => r.roomId));
  const insights = (usage.data?.insights ?? []).filter((i) => shownRooms.has(i.roomId));
  const bySite = [
    ...new Map(
      rows.map((r) => [r.siteId ?? '', { key: r.siteId ?? '', name: r.siteName ?? 'No site' }]),
    ).values(),
  ]
    .sort((a, b) => (a.key === '' ? 1 : 0) - (b.key === '' ? 1 : 0) || a.name.localeCompare(b.name))
    .map((g) => {
      const mine = rows.filter((r) => (r.siteId ?? '') === g.key);
      return { ...g, rows: mine, average: averageOf(mine) };
    });

  return (
    <PageContainer>
      <PageHeader
        title="Usage"
        description="How the rooms are used, worked out from what their devices report. What counts as in use is set under Room definitions."
        actions={
          <>
            {sites.length > 1 && (
              <SimpleSelect
                size="sm"
                className="w-44"
                value={oneSite ? view : view === 'bysite' ? 'bysite' : 'all'}
                onValueChange={setView}
                options={[
                  { value: 'all', label: 'Whole organisation' },
                  { value: 'bysite', label: 'Site by site' },
                  ...sites.map((x) => ({ value: x.id, label: x.name })),
                ]}
              />
            )}
            <SimpleSelect
              size="sm"
              className="w-40"
              value={kind}
              onValueChange={(v) => setKind(v as UsageKind)}
              options={[
                { value: 'av', label: USAGE_KIND_LABEL.av },
                { value: 'occupied', label: USAGE_KIND_LABEL.occupied },
              ]}
            />
            <SimpleSelect
              size="sm"
              className="w-36"
              value={String(days)}
              onValueChange={(v) => setDays(Number(v))}
              options={[
                { value: '7', label: 'Last 7 days' },
                { value: '30', label: 'Last 30 days' },
                { value: '90', label: 'Last 90 days' },
              ]}
            />
          </>
        }
      />
      {usage.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : usage.isError ? (
        <EmptyState
          icon={BarChart3}
          title="Usage is not available"
          description="Your plan may not include analytics."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="Nothing to measure yet"
          description="Usage comes from monitored devices. Add networked devices with a driver to your rooms."
        />
      ) : (
        <>
          <UsageSummary rows={shown} />
          {insights.length > 0 && (
            <section className="overflow-hidden rounded-lg border">
              <button
                type="button"
                aria-expanded={showInsights}
                onClick={() => setShowInsights(!showInsights)}
                className="flex w-full items-center justify-between gap-3 bg-muted/40 px-4 py-2.5 text-left"
              >
                <h2 className="flex items-center gap-2 text-sm font-medium">
                  <Lightbulb className="size-4 text-warning" />
                  Worth a look
                  <Badge variant="secondary">{insights.length}</Badge>
                </h2>
                <ChevronDown
                  className={`size-4 text-muted-foreground transition-transform ${showInsights ? 'rotate-180' : ''}`}
                />
              </button>
              {showInsights && (
                <ul className="divide-y border-t">
                  {insights.map((i, n) => (
                    <li key={n} className="flex items-start gap-3 px-4 py-3 text-sm">
                      <Lightbulb className="mt-0.5 size-4 shrink-0 text-warning" />
                      <div>
                        <Link
                          href={orgPath(orgId, `/rooms/${i.roomId}/usage`)}
                          className="font-medium hover:underline"
                        >
                          {i.title}
                        </Link>
                        <div className="text-xs text-muted-foreground">{i.detail}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {view === 'bysite' ? (
            <div className="space-y-4">
              {bySite.map((g) => (
                <section key={g.key} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-4">
                    <h2 className="text-sm font-medium">
                      {g.name}{' '}
                      <span className="text-xs font-normal text-muted-foreground">
                        {plural(g.rows.length, 'room')}
                      </span>
                    </h2>
                    {g.average !== null && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        Average
                        <div className="h-2 w-28 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full bg-brand"
                            style={{ width: `${Math.max(2, Math.round(g.average * 100))}%` }}
                          />
                        </div>
                        <span className="tabular w-10 text-right text-sm font-semibold text-foreground">
                          {pct(g.average)}
                        </span>
                      </div>
                    )}
                  </div>
                  <UsageTable rows={g.rows} />
                </section>
              ))}
            </div>
          ) : (
            <UsageTable rows={shown} />
          )}
        </>
      )}
    </PageContainer>
  );
}
