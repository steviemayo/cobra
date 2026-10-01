'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { LatencyChart } from '@/components/common/latency-chart';
import { Section } from '@/components/common/section';
import { SimpleSelect } from '@/components/common/simple-select';
import { Stat } from '@/components/common/stat';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Range = '24h' | '7d' | '30d';
const RANGES: { value: Range; label: string }[] = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];

type Summary = RouterOutputs['latency']['device']['summary'];

const ms = (n: number | null) => (n === null ? '–' : `${n} ms`);

function Summaries({ s }: { s: Summary }) {
  return (
    <div className="grid grid-cols-2 gap-3 px-4 pt-4 sm:grid-cols-4">
      <Stat label="Average, last 24 hours" value={ms(s.avgMs)} />
      <Stat label="Slowest ping" value={ms(s.maxMs)} />
      <Stat label="Pings with no answer" value={`${s.lossPct}%`} />
      <Stat
        label="Compared with usual"
        value={s.changePct === null ? '–' : `${s.changePct > 0 ? '+' : ''}${s.changePct}%`}
        hint={s.usualMs === null ? 'Needs a day of history' : `Usually ${s.usualMs} ms`}
      />
    </div>
  );
}

/** How long one device takes to answer the gateway, over time. */
export function DeviceResponse({ deviceId }: { deviceId: string }) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [range, setRange] = useState<Range>('24h');
  const q = useQuery({
    ...trpc.latency.device.queryOptions({ orgId, deviceId, range }),
    refetchInterval: 60_000,
    retry: false,
  });
  return (
    <Section
      title="Response time"
      action={
        <SimpleSelect
          size="sm"
          className="w-40"
          value={range}
          onValueChange={setRange}
          options={RANGES}
        />
      }
    >
      {q.isPending ? (
        <Skeleton className="m-4 h-56" />
      ) : q.isError ? (
        <p className="p-4 text-sm text-muted-foreground">Response times are not available.</p>
      ) : (
        <>
          <Summaries s={q.data.summary} />
          <div className="p-4">
            <LatencyChart points={q.data.points} />
          </div>
        </>
      )}
    </Section>
  );
}

/** The network at a site: every device's answers together, and which devices are doing worst. */
export function SiteNetwork({ siteId }: { siteId: string }) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [range, setRange] = useState<Range>('24h');
  const q = useQuery({
    ...trpc.latency.site.queryOptions({ orgId, siteId, range }),
    refetchInterval: 60_000,
    retry: false,
  });
  if (q.isError) return null;
  return (
    <Section
      title="Network health"
      action={
        <SimpleSelect
          size="sm"
          className="w-40"
          value={range}
          onValueChange={setRange}
          options={RANGES}
        />
      }
    >
      {q.isPending ? (
        <Skeleton className="m-4 h-56" />
      ) : (
        <>
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            How quickly the devices at this site answer the gateway. A rise across many devices
            points to the network (a switch, a link, a busy segment) rather than one device.
          </p>
          <Summaries s={q.data.summary} />
          <div className="p-4">
            <LatencyChart points={q.data.points} />
          </div>
          {q.data.worst.length > 0 && (
            <div className="border-t">
              <h3 className="px-4 pt-3 text-xs font-medium text-muted-foreground">
                Slowest devices, last 24 hours
              </h3>
              <ul className="divide-y">
                {q.data.worst.map((w) => (
                  <li
                    key={w.deviceId}
                    className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate">
                      <Link
                        href={orgPath(orgId, `/assets/${w.deviceId}`)}
                        className="hover:underline"
                      >
                        {w.name}
                      </Link>
                      {w.roomName && <span className="text-muted-foreground"> · {w.roomName}</span>}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {ms(w.avgMs)}
                      {w.lossPct > 0 && (
                        <span className="ml-2 text-destructive">{w.lossPct}% lost</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

const FIELDS = [
  {
    key: 'factor',
    label: 'Slow when this many times the usual',
    hint: 'The last 15 minutes against the device’s own usual (the middle hour of the past week).',
    unit: '×',
    step: 0.1,
  },
  {
    key: 'minIncreaseMs',
    label: '…and at least this much slower',
    hint: 'Stops a device that normally answers in 2 ms being flagged at 5 ms.',
    unit: 'ms',
    step: 1,
  },
  {
    key: 'highMs',
    label: 'Always slow above',
    hint: 'An average over the last 15 minutes above this is slow, whatever the usual.',
    unit: 'ms',
    step: 10,
  },
  {
    key: 'lossPercent',
    label: 'Dropping pings at',
    hint: 'The share of the last 15 minutes’ pings with no answer.',
    unit: '%',
    step: 1,
  },
] as const;

/** When response times count as a problem. Kestrel's defaults, changeable, with a way back. */
export function NetworkHealthSettings() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, role } = useOrg();
  const q = useQuery({ ...trpc.latency.limits.queryOptions({ orgId }), retry: false });
  const [edit, setEdit] = useState<Record<string, string>>({});
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.latency.limits.queryKey() });
  const save = useMutation(
    trpc.latency.saveLimits.mutationOptions({
      onSuccess: async () => {
        setEdit({});
        await refresh();
        toast.success('Network health limits saved');
      },
    }),
  );
  const reset = useMutation(
    trpc.latency.resetLimits.mutationOptions({
      onSuccess: async () => {
        setEdit({});
        await refresh();
        toast.success('Back to Kestrel’s defaults');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (!q.data) return null;
  const canEdit = role === 'owner' || role === 'dev';
  const value = (k: (typeof FIELDS)[number]['key']) => edit[k] ?? String(q.data.limits[k]);
  const dirty = FIELDS.some(
    (f) => edit[f.key] !== undefined && Number(edit[f.key]) !== q.data.limits[f.key],
  );

  return (
    <section className="space-y-4 border-t pt-6">
      <div>
        <h2 className="text-sm font-medium">Network health</h2>
        <p className="text-sm text-muted-foreground">
          Gateways ping each device. Kestrel raises an incident when a device answers slowly or
          drops pings, and one for the whole site when several do together. These are the limits.
        </p>
      </div>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({
            orgId,
            factor: Number(value('factor')),
            minIncreaseMs: Number(value('minIncreaseMs')),
            highMs: Number(value('highMs')),
            lossPercent: Number(value('lossPercent')),
          });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {FIELDS.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label htmlFor={`lat-${f.key}`}>{f.label}</Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`lat-${f.key}`}
                  type="number"
                  inputMode="decimal"
                  step={f.step}
                  disabled={!canEdit}
                  value={value(f.key)}
                  onChange={(e) => setEdit({ ...edit, [f.key]: e.target.value })}
                  className="w-28"
                />
                <span className="text-sm text-muted-foreground">{f.unit}</span>
                <span className="text-xs text-muted-foreground">
                  default {q.data.defaults[f.key]}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{f.hint}</p>
            </div>
          ))}
        </div>
        {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
        {canEdit && (
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={!dirty || save.isPending}>
              {save.isPending && <Spinner />}
              Save limits
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!q.data.custom || reset.isPending}
              onClick={() => reset.mutate({ orgId })}
            >
              Reset to default
            </Button>
          </div>
        )}
      </form>
    </section>
  );
}
