'use client';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { DEVICE_FEEDBACK_FIELDS } from '@kestrel/model';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
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
import { assignChartSlots, chartSlotBg } from '@/lib/chart-colors';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Days = RouterOutputs['monitoring']['deviceHistoryDaily']['days'];

const RANGES = [7, 30, 90] as const;
// "online" first: it's the one every device has, whether or not it reports anything else.
const FIELDS = ['online', ...DEVICE_FEEDBACK_FIELDS] as const;
const FIELD_LABEL: Record<string, string> = {
  online: 'Online',
  power: 'Power',
  input: 'Input',
  muted: 'Mute',
  volume: 'Volume',
  blanked: 'Blanked',
  recording: 'Recording',
  occupied: 'Occupied',
  streamConnected: 'Stream connected',
  activeApp: 'App',
};

const minutesLabel = (m: number): string => {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
};
const dateLabel = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** Every distinct value across the days, ordered by total minutes — the chart's stacking and legend order. */
function orderValues(days: Days): string[] {
  const totals = new Map<string, number>();
  for (const day of days)
    for (const d of day.durations) totals.set(d.value, (totals.get(d.value) ?? 0) + d.minutes);
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}

/** A stacked bar per day: each day's own total is its own 100%, so a short first or last day still fills its column. */
function HistoryChart({ days, slots }: { days: Days; slots: Map<string, number> }) {
  return (
    <div className="overflow-x-auto px-4 py-4">
      <div
        className="flex h-40 min-w-full items-end gap-1"
        role="img"
        aria-label="Time in each value, by day"
      >
        {days.map((day) => {
          const total = day.durations.reduce((n, d) => n + d.minutes, 0);
          return (
            <div
              key={day.date}
              className="group flex h-full min-w-2 flex-1 flex-col-reverse gap-0.5"
            >
              {total === 0 ? (
                <div
                  className="h-1 w-full rounded-sm bg-muted"
                  title={`${dateLabel(day.date)}: no data`}
                />
              ) : (
                day.durations
                  .slice()
                  .reverse()
                  .map((d) => (
                    <div
                      key={d.value}
                      title={`${dateLabel(day.date)} — ${d.value}: ${minutesLabel(d.minutes)}`}
                      className={`w-full rounded-[1px] ${chartSlotBg(slots.get(d.value) ?? 0)} group-hover:opacity-80`}
                      style={{ height: `${Math.max(2, (d.minutes / total) * 100)}%` }}
                    />
                  ))
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{days[0] && dateLabel(days[0].date)}</span>
        <span>{days[days.length - 1] && dateLabel(days[days.length - 1]!.date)}</span>
      </div>
    </div>
  );
}

function Legend({
  values,
  slots,
  totalsByValue,
}: {
  values: string[];
  slots: Map<string, number>;
  totalsByValue: Map<string, number>;
}) {
  const grand = [...totalsByValue.values()].reduce((n, m) => n + m, 0);
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 border-t px-4 py-3 text-sm">
      {values.map((v) => {
        const minutes = totalsByValue.get(v) ?? 0;
        return (
          <li key={v} className="flex items-center gap-1.5">
            <span
              className={`size-2.5 shrink-0 rounded-full ${chartSlotBg(slots.get(v) ?? 0)}`}
              aria-hidden
            />
            <span className="font-medium">{v}</span>
            <span className="text-muted-foreground">
              {minutesLabel(minutes)}
              {grand > 0 && ` (${Math.round((minutes / grand) * 100)}%)`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The exact per-day numbers, for anyone who can't read the chart by colour alone. */
function HistoryTable({ days, values }: { days: Days; values: string[] }) {
  return (
    <div className="overflow-x-auto border-t">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead>Day</TableHead>
            {values.map((v) => (
              <TableHead key={v} className="text-right">
                {v}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {days.map((day) => {
            const by = new Map(day.durations.map((d) => [d.value, d.minutes]));
            return (
              <TableRow key={day.date}>
                <TableCell>{dateLabel(day.date)}</TableCell>
                {values.map((v) => (
                  <TableCell key={v} className="text-right tabular-nums text-muted-foreground">
                    {by.has(v) ? minutesLabel(by.get(v)!) : '—'}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export function DeviceHistoryView({ roomId }: { roomId: string }) {
  const params = useSearchParams();
  const deviceId = params.get('device') ?? '';
  const deviceName = params.get('name') ?? deviceId;
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [field, setField] = useState<(typeof FIELDS)[number]>(
    (params.get('field') as (typeof FIELDS)[number] | null) ?? 'online',
  );
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [showTable, setShowTable] = useState(false);
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);

  const history = useQuery({
    ...trpc.monitoring.deviceHistoryDaily.queryOptions({
      orgId,
      roomId,
      deviceId,
      field,
      days,
      tz,
    }),
    enabled: !!deviceId,
    staleTime: 60_000,
  });

  const dayData = history.data?.days ?? [];
  const values = useMemo(() => orderValues(dayData), [dayData]);
  const slots = useMemo(() => assignChartSlots(values), [values]);
  const totalsByValue = useMemo(() => {
    const m = new Map<string, number>();
    for (const day of dayData)
      for (const d of day.durations) m.set(d.value, (m.get(d.value) ?? 0) + d.minutes);
    return m;
  }, [dayData]);
  const hasData = values.length > 0;

  if (!deviceId)
    return (
      <PageContainer>
        <EmptyState
          icon={History}
          title="No device chosen"
          description="Open this from a device on the Monitoring page."
        />
      </PageContainer>
    );

  return (
    <PageContainer>
      <PageHeader
        title={`${deviceName} — history`}
        description="How long this device's own feedback has held each value, control or not."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SimpleSelect
              size="sm"
              value={field}
              onValueChange={setField}
              options={FIELDS.map((f) => ({ value: f, label: FIELD_LABEL[f] ?? f }))}
            />
            <div className="flex rounded-md border p-0.5" role="group" aria-label="Period">
              {RANGES.map((r) => (
                <Button
                  key={r}
                  size="xs"
                  variant={days === r ? 'secondary' : 'ghost'}
                  onClick={() => setDays(r)}
                >
                  {r} days
                </Button>
              ))}
            </div>
          </div>
        }
      />

      <section className="overflow-hidden rounded-lg border">
        <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2.5">
          <h2 className="text-sm font-medium">{FIELD_LABEL[field] ?? field}</h2>
          {hasData && (
            <Button variant="ghost" size="xs" onClick={() => setShowTable((s) => !s)}>
              {showTable ? 'Hide table' : 'Show as a table'}
            </Button>
          )}
        </div>
        {history.isPending ? (
          <Skeleton className="m-4 h-40" />
        ) : history.isError ? (
          <p className="px-4 py-6 text-sm text-destructive">{history.error.message}</p>
        ) : !hasData ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            Nothing logged for {FIELD_LABEL[field]?.toLowerCase() ?? field} in this period.
          </p>
        ) : (
          <>
            <HistoryChart days={dayData} slots={slots} />
            <Legend values={values} slots={slots} totalsByValue={totalsByValue} />
            {showTable && <HistoryTable days={dayData} values={values} />}
            {history.data?.truncated && (
              <p className="border-t px-4 py-2 text-xs text-muted-foreground">
                There were more changes than could be read for this period, so this is a partial
                picture. Try a shorter period.
              </p>
            )}
          </>
        )}
      </section>
    </PageContainer>
  );
}
