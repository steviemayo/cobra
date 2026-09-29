'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, Lightbulb } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { percent, plural } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Report = RouterOutputs['usage']['report'];

const RANGES = [7, 30, 90] as const;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const hours = (minutes: number) => {
  const h = minutes / 60;
  return h >= 10 ? `${Math.round(h)} h` : `${Math.round(h * 10) / 10} h`;
};
const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border px-4 py-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b bg-muted/40 px-4 py-2.5">
        <h2 className="text-sm font-medium">{title}</h2>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
      {children}
    </section>
  );
}

/** Hours in use each day, as bars. */
function DailyBars({ daily }: { daily: Report['daily'] }) {
  const max = Math.max(1, ...daily.map((d) => d.inUseMinutes));
  return (
    <div className="px-4 py-4">
      <div className="flex h-36 items-end gap-px" role="img" aria-label="Hours in use each day">
        {daily.map((d) => (
          <div
            key={d.date}
            className="group relative flex h-full min-w-0 flex-1 items-end"
            title={`${d.date}: ${hours(d.inUseMinutes)}`}
          >
            <div
              className="w-full rounded-t-sm bg-primary/80 group-hover:bg-primary"
              style={{ height: `${Math.max(d.inUseMinutes > 0 ? 2 : 0, (d.inUseMinutes / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{daily[0]?.date}</span>
        <span>{daily[daily.length - 1]?.date}</span>
      </div>
    </div>
  );
}

/** Which days and hours rooms are used, darker meaning more. Business hours are outlined. */
function Heatmap({ report }: { report: Report }) {
  const max = Math.max(1, ...report.heatmap.flat());
  return (
    <div className="overflow-x-auto px-4 py-4">
      <div className="min-w-[36rem]">
        <div className="ml-10 grid grid-cols-24 gap-px text-[10px] text-muted-foreground" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}>
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="text-center">
              {h % 3 === 0 ? hourLabel(h) : ''}
            </span>
          ))}
        </div>
        {report.heatmap.map((row, d) => (
          <div key={DAYS[d]} className="mt-px flex items-center gap-2">
            <span className="w-8 text-xs text-muted-foreground">{DAYS[d]}</span>
            <div className="grid flex-1 gap-px" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}>
              {row.map((m, h) => {
                const business = d < 5 && h >= report.businessStartHour && h < report.businessEndHour;
                return (
                  <div
                    key={h}
                    title={`${DAYS[d]} ${hourLabel(h)}: ${hours(m)} in use across all rooms`}
                    className={cn('h-5 rounded-[2px] bg-muted', business && 'ring-1 ring-inset ring-border')}
                  >
                    <div className="size-full rounded-[2px] bg-primary" style={{ opacity: m === 0 ? 0 : 0.15 + 0.85 * (m / max) }} />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivityBars({ activities }: { activities: Report['activities'] }) {
  const max = Math.max(1, ...activities.map((a) => a.count));
  if (activities.length === 0)
    return <p className="px-4 py-4 text-sm text-muted-foreground">No activities were started in this period.</p>;
  return (
    <ul className="divide-y">
      {activities.slice(0, 8).map((a) => (
        <li key={a.name} className="flex items-center gap-3 px-4 py-2 text-sm">
          <span className="w-40 shrink-0 truncate">{a.name}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary/80" style={{ width: `${(a.count / max) * 100}%` }} />
          </div>
          <span className="w-12 text-right tabular-nums text-muted-foreground">{a.count}</span>
        </li>
      ))}
    </ul>
  );
}

/** How much rooms are used, when and for what, and whether anyone is in them while they are on. */
export function UsageView() {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [site, setSite] = useState('all');
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const report = useQuery({
    ...trpc.usage.report.queryOptions({ orgId, days, tz, siteId: site === 'all' ? undefined : site }),
    staleTime: 60_000,
  });
  const sites = useQuery(trpc.site.list.queryOptions({ orgId }));

  const data = report.data;
  const rooms = useMemo(() => data?.rooms ?? [], [data]);
  const withData = rooms.filter((r) => r.utilisation !== null);
  const anyOccupancy = rooms.some((r) => r.hasOccupancy);
  const totalMinutes = rooms.reduce((n, r) => n + r.inUseMinutes, 0);
  const sessions = rooms.reduce((n, r) => n + r.sessions, 0);
  const avgUtil = withData.length ? withData.reduce((n, r) => n + (r.utilisation ?? 0), 0) / withData.length : null;
  const emptyMinutes = rooms.reduce((n, r) => n + r.inUseEmptyMinutes, 0);
  const onMinutesWithSensor = rooms.filter((r) => r.hasOccupancy).reduce((n, r) => n + r.inUseMinutes, 0);
  const insights = data?.insights ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="Usage"
        description="How much each room is used, when, and for what. A room counts as in use while it is on."
        actions={
          <div className="flex items-center gap-2">
            {(sites.data?.length ?? 0) > 1 && (
              <SimpleSelect
                size="sm"
                value={site}
                onValueChange={setSite}
                options={[{ value: 'all', label: 'All sites' }, ...(sites.data ?? []).map((s) => ({ value: s.id, label: s.name }))]}
              />
            )}
            <div className="flex rounded-md border p-0.5" role="group" aria-label="Period">
              {RANGES.map((r) => (
                <Button key={r} size="xs" variant={days === r ? 'secondary' : 'ghost'} onClick={() => setDays(r)}>
                  {r} days
                </Button>
              ))}
            </div>
          </div>
        }
      />

      {report.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : report.isError ? (
        <p className="text-sm text-destructive">{report.error.message}</p>
      ) : rooms.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="No rooms to report on"
          description="Usage appears once rooms are deployed to a gateway and have been used."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Hours in use" value={hours(totalMinutes)} hint={`across ${plural(rooms.length, 'room')}`} />
            <Stat label="Business hours in use" value={percent(avgUtil)} hint="average per room" />
            <Stat label="Sessions" value={String(sessions)} hint={sessions ? `${hours(totalMinutes / sessions)} on average` : undefined} />
            {anyOccupancy ? (
              <Stat
                label="On with nobody in it"
                value={percent(onMinutesWithSensor ? emptyMinutes / onMinutesWithSensor : null)}
                hint="rooms with a presence sensor"
              />
            ) : (
              <Stat label="Presence" value="No sensors" hint="Add an occupancy sensor to see who is in a room" />
            )}
          </div>

          {data?.truncated && (
            <p className="rounded-md bg-warning/10 px-3 py-2 text-sm">
              There was more activity than could be read for this period, so these figures are lower than the real ones.
              Try a shorter period.
            </p>
          )}

          {insights.length > 0 && (
            <Section title="Worth a look">
              <ul className="divide-y">
                {insights.map((i) => (
                  <li key={`${i.kind}-${i.roomId}`} className="flex items-start gap-2 px-4 py-2.5 text-sm">
                    <Lightbulb className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span>{i.text}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {data && (
            <>
              <Section title="Hours in use each day" note="all rooms together">
                <DailyBars daily={data.daily} />
              </Section>
              <Section title="When rooms are used" note={`in ${data.tz}; business hours outlined`}>
                <Heatmap report={data} />
              </Section>
            </>
          )}

          <Section title="Rooms" note="most used first">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Room</TableHead>
                  <TableHead>Business hours in use</TableHead>
                  <TableHead className="text-right">Hours in use</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
                  <TableHead className="text-right">Average session</TableHead>
                  {anyOccupancy && <TableHead className="text-right">On, nobody in</TableHead>}
                  {anyOccupancy && <TableHead className="text-right">In, but off</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rooms.map((r) => (
                  <TableRow key={r.roomId}>
                    <TableCell className="font-medium">
                      <Link href={orgPath(orgId, `/rooms/${r.roomId}`)} className="hover:underline">
                        {r.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary/80" style={{ width: `${(r.utilisation ?? 0) * 100}%` }} />
                        </div>
                        <span className="tabular-nums text-sm">{percent(r.utilisation)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{hours(r.inUseMinutes)}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.sessions}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.avgSessionMinutes === null ? '—' : hours(r.avgSessionMinutes)}
                    </TableCell>
                    {anyOccupancy && (
                      <TableCell className="text-right tabular-nums">{r.hasOccupancy ? hours(r.inUseEmptyMinutes) : '—'}</TableCell>
                    )}
                    {anyOccupancy && (
                      <TableCell className="text-right tabular-nums">{r.hasOccupancy ? hours(r.occupiedIdleMinutes) : '—'}</TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>

          <Section title="What rooms are used for" note="activities started">
            <ActivityBars activities={data?.activities ?? []} />
          </Section>

          <p className="text-xs text-muted-foreground">
            Worked out from what gateways report, which is kept for 90 days. Business hours are Monday to Friday, {hourLabel(data?.businessStartHour ?? 8)} to {hourLabel(data?.businessEndHour ?? 18)}.
            A room that was first heard from partway through the period is measured from then.
          </p>
        </>
      )}
    </PageContainer>
  );
}
