'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  ASSET_STATUSES,
  DeviceDetails,
  assetCategoryLabel,
  type DeviceLiveState,
  type FieldProvenance,
} from '@kestrel/model';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { SeverityPill, dateTime } from '@/components/common/health';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { Section } from '@/components/common/section';
import { useSiteZone } from '@/lib/use-estate';
import { DevicePoints } from './device-points';
import { AddressNotice, DeviceAddress } from './device-address';
import { DeviceSettings } from './device-settings';
import { DeviceResponse } from './network-health';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { formatDate, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';
import { LineSeries, StateStrip, minutesLabel } from '@/components/common/usage-charts';
import { RequireFeature } from '@/components/common/plan-gate';
import { DeviceConfig } from './device-config';
import { PmRuns } from './pm-records';
import { PmSchedules } from './pm-schedule';
import { DeviceDetailsView } from './device-details';

type Device = RouterOutputs['device']['get'];

/** The time zone of the site a device is at (its page already holds the device, so this costs nothing). */
function useDeviceZone(deviceId: string): string | null {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const device = useQuery(trpc.device.get.queryOptions({ orgId, deviceId }));
  return useSiteZone(device.data?.siteId);
}
type DeviceEvent = RouterOutputs['device']['events'][number];

const STATE_LABEL: Record<DeviceLiveState, string> = {
  online: 'Online',
  offline: 'Offline',
  unknown: 'Unknown',
  none: 'Recorded only',
};
const STATE_TONE: Record<DeviceLiveState, string> = {
  online: 'bg-success',
  offline: 'bg-destructive',
  unknown: 'bg-muted-foreground/35',
  none: 'bg-transparent border border-muted-foreground/40',
};

export function DeviceStateBadge({ state }: { state: DeviceLiveState }) {
  return (
    <span
      className="inline-flex items-center gap-2 text-sm"
      title={
        state === 'unknown'
          ? 'Its gateway is not reachable, or it has not reported yet'
          : state === 'none'
            ? 'An asset record: it is not polled'
            : undefined
      }
    >
      <span
        aria-hidden
        className={cn('inline-block size-2 shrink-0 rounded-full', STATE_TONE[state])}
      />
      <span className={cn(state === 'unknown' || state === 'none' ? 'text-muted-foreground' : '')}>
        {STATE_LABEL[state]}
      </span>
    </span>
  );
}

// ---- Asset fields, with where each value came from ---------------------------------------------

const TEXT_FIELDS = [
  { key: 'make', label: 'Make' },
  { key: 'model', label: 'Model' },
  { key: 'serial', label: 'Serial number' },
  { key: 'mac', label: 'MAC address' },
  { key: 'ip', label: 'IP address' },
  { key: 'firmware', label: 'Firmware' },
  { key: 'assetTag', label: 'Asset tag' },
  { key: 'supplier', label: 'Supplier' },
] as const;
type TextKey = (typeof TEXT_FIELDS)[number]['key'];
const DATE_FIELDS = [
  { key: 'installedOn', label: 'Installed' },
  { key: 'warrantyEndsOn', label: 'Warranty ends' },
  { key: 'endOfLifeOn', label: 'End of life' },
] as const;
type DateKey = (typeof DATE_FIELDS)[number]['key'];
const STATUS_LABEL: Record<string, string> = {
  in_service: 'In service',
  spare: 'Spare',
  in_repair: 'In repair',
  retired: 'Retired',
};

const toInput = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');

function Source({ field, prov }: { field: string; prov: FieldProvenance | undefined }) {
  if (!prov) return null;
  if (prov.source === 'discovered')
    return (
      <Badge variant="secondary" className="font-normal" title="Read from the device by its driver">
        From device
      </Badge>
    );
  return (
    <span className="inline-flex items-center gap-2">
      <Badge variant="outline" className="font-normal" title={`Typed in ${formatDate(prov.at)}`}>
        Entered
      </Badge>
      {prov.discovered && (
        <span
          className="inline-flex items-center gap-1 text-xs text-warning"
          title={`The device reports ${prov.discovered} for ${field}`}
        >
          <AlertTriangle className="size-3" /> Device says {prov.discovered}
        </span>
      )}
    </span>
  );
}

function AssetDetails({ device }: { device: Device }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport } = useOrg();
  const canEdit = canSupport;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState<Record<TextKey, string>>(
    () =>
      Object.fromEntries(TEXT_FIELDS.map((f) => [f.key, device[f.key] ?? ''])) as Record<
        TextKey,
        string
      >,
  );
  const [dates, setDates] = useState<Record<DateKey, string>>(
    () =>
      Object.fromEntries(DATE_FIELDS.map((f) => [f.key, toInput(device[f.key])])) as Record<
        DateKey,
        string
      >,
  );
  const [status, setStatus] = useState(device.status);
  const [notes, setNotes] = useState(device.notes ?? '');
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: trpc.device.get.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.device.events.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.device.list.queryKey() }),
    ]);
  };
  const save = useMutation(
    trpc.device.update.mutationOptions({
      onSuccess: async () => {
        toast.success('Saved');
        setEditing(false);
        await refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  function submit() {
    const patch: Record<string, unknown> = {
      orgId,
      deviceId: device.id,
      status,
      notes: notes || null,
    };
    for (const f of TEXT_FIELDS)
      if ((text[f.key] || null) !== (device[f.key] ?? null)) patch[f.key] = text[f.key] || null;
    for (const f of DATE_FIELDS)
      if (dates[f.key] !== toInput(device[f.key]))
        patch[f.key] = dates[f.key] ? new Date(dates[f.key]) : null;
    save.mutate(patch as never);
  }

  return (
    <Section
      title="Asset details"
      action={
        canEdit &&
        (editing ? (
          <div className="flex gap-2">
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="xs" onClick={submit} disabled={save.isPending}>
              Save
            </Button>
          </div>
        ) : (
          <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
            Edit
          </Button>
        ))
      }
    >
      <dl className="divide-y">
        {TEXT_FIELDS.map((f) => {
          const prov = device.provenance[f.key as keyof typeof device.provenance];
          return (
            <div
              key={f.key}
              className="grid items-center gap-2 px-4 py-2.5 sm:grid-cols-[10rem_1fr_auto]"
            >
              <dt className="text-sm text-muted-foreground">{f.label}</dt>
              <dd className="min-w-0">
                {editing ? (
                  <Input
                    value={text[f.key]}
                    onChange={(e) => setText({ ...text, [f.key]: e.target.value })}
                    className="h-8"
                    maxLength={200}
                  />
                ) : (
                  <span
                    className={cn(
                      'text-sm',
                      ['serial', 'mac'].includes(f.key) && 'font-mono text-xs',
                    )}
                  >
                    {device[f.key] || <span className="text-muted-foreground">Not recorded</span>}
                  </span>
                )}
              </dd>
              <div className="text-xs">
                <Source field={f.label.toLowerCase()} prov={prov} />
              </div>
            </div>
          );
        })}
        {DATE_FIELDS.map((f) => (
          <div
            key={f.key}
            className="grid items-center gap-2 px-4 py-2.5 sm:grid-cols-[10rem_1fr_auto]"
          >
            <dt className="text-sm text-muted-foreground">{f.label}</dt>
            <dd>
              {editing ? (
                <Input
                  type="date"
                  value={dates[f.key]}
                  onChange={(e) => setDates({ ...dates, [f.key]: e.target.value })}
                  className="h-8 w-44"
                />
              ) : device[f.key] ? (
                <span className="text-sm">{formatDate(device[f.key]!)}</span>
              ) : (
                <span className="text-sm text-muted-foreground">Not recorded</span>
              )}
            </dd>
            <div />
          </div>
        ))}
        <div className="grid items-center gap-2 px-4 py-2.5 sm:grid-cols-[10rem_1fr_auto]">
          <dt className="text-sm text-muted-foreground">Status</dt>
          <dd>
            {editing ? (
              <SimpleSelect
                size="sm"
                className="w-44"
                value={status}
                onValueChange={setStatus}
                options={ASSET_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s]! }))}
              />
            ) : (
              <span className="text-sm">{STATUS_LABEL[device.status] ?? device.status}</span>
            )}
          </dd>
          <div />
        </div>
        <div className="grid gap-2 px-4 py-2.5 sm:grid-cols-[10rem_1fr]">
          <dt className="text-sm text-muted-foreground">Notes</dt>
          <dd>
            {editing ? (
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                maxLength={2000}
              />
            ) : (
              <span className="whitespace-pre-wrap text-sm">
                {device.notes || <span className="text-muted-foreground">None</span>}
              </span>
            )}
          </dd>
        </div>
      </dl>
    </Section>
  );
}

// ---- Swap notice -------------------------------------------------------------------------------

function SwapNotice({ device }: { device: Device }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport } = useOrg();
  const [note, setNote] = useState('');
  const resolve = useMutation(
    trpc.device.resolveSwap.mutationOptions({
      onSuccess: async () => {
        toast.success('Recorded');
        await Promise.all([
          qc.invalidateQueries({ queryKey: trpc.device.get.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.device.events.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.device.list.queryKey() }),
        ]);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (!device.swapPending) return null;
  return (
    <div className="space-y-3 rounded-lg border border-warning/50 bg-warning/5 p-4">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="text-sm">
          <div className="font-medium">Serial number, MAC or model changed</div>
          <p className="text-muted-foreground">
            This device may have been replaced. Say whether it was swapped for another unit, or
            whether the earlier value was simply wrong. Either way the change stays in the history.
          </p>
        </div>
      </div>
      {canSupport && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note (for example the ticket or job number)"
            className="h-8 max-w-sm"
            maxLength={500}
          />
          <Button
            size="sm"
            disabled={resolve.isPending}
            onClick={() =>
              resolve.mutate({
                orgId,
                deviceId: device.id,
                outcome: 'replaced',
                note: note || undefined,
              })
            }
          >
            It was replaced
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={resolve.isPending}
            onClick={() =>
              resolve.mutate({
                orgId,
                deviceId: device.id,
                outcome: 'correction',
                note: note || undefined,
              })
            }
          >
            A correction, no swap
          </Button>
        </div>
      )}
    </div>
  );
}

// ---- History -----------------------------------------------------------------------------------

const FIELD_LABEL: Record<string, string> = {
  make: 'Make',
  model: 'Model',
  serial: 'Serial number',
  mac: 'MAC address',
  ip: 'IP address',
  firmware: 'Firmware',
  assetTag: 'Asset tag',
  supplier: 'Supplier',
  status: 'Status',
  name: 'Name',
  category: 'Category',
  notes: 'Notes',
  installedOn: 'Installed',
  warrantyEndsOn: 'Warranty end',
  endOfLifeOn: 'End of life',
  driver: 'Driver',
  address: 'Address',
  settings: 'Settings',
  login: 'Login',
  'credential set': 'Credential set',
  room: 'Room',
};
const fieldLabel = (f: string | null) => (f ? (FIELD_LABEL[f] ?? f) : '');
const show = (v: string | null) => (v === null || v === '' ? 'nothing' : v);

function describe(e: DeviceEvent): { title: string; detail?: string; tone?: 'warn' } {
  const who =
    e.source === 'discovered' ? 'the device' : e.source === 'manual' ? 'a person' : 'Kestrel';
  switch (e.type) {
    case 'created':
      return { title: 'Added to the register', detail: e.newValue ?? undefined };
    case 'field_changed':
      return e.oldValue !== null || e.newValue !== null
        ? {
            title: `${fieldLabel(e.field)} changed`,
            detail: `${show(e.oldValue)} to ${show(e.newValue)}, by ${who}`,
          }
        : { title: `${fieldLabel(e.field)} updated`, detail: `by ${who}` };
    case 'status_changed':
      return {
        title: 'Status changed',
        detail: `${STATUS_LABEL[e.oldValue ?? ''] ?? show(e.oldValue)} to ${STATUS_LABEL[e.newValue ?? ''] ?? show(e.newValue)}`,
      };
    case 'moved':
      return { title: 'Moved to another room' };
    case 'gateway_changed':
      return { title: 'Gateway changed' };
    case 'address_changed':
      return {
        title: 'Address changed',
        detail: `${show(e.oldValue)} to ${show(e.newValue)}`,
      };
    case 'upgraded':
      return { title: 'Now monitored', detail: 'A driver was added to a recorded asset' };
    case 'swap_flagged':
      return {
        title: `${fieldLabel(e.field)} changed: possible replacement`,
        detail: `${show(e.oldValue)} to ${show(e.newValue)}`,
        tone: 'warn',
      };
    case 'swap_confirmed':
      return { title: 'Confirmed as replaced', detail: (e.data as { note?: string } | null)?.note };
    case 'swap_dismissed':
      return {
        title: 'Marked as a correction, not a swap',
        detail: (e.data as { note?: string } | null)?.note,
      };
    default:
      return { title: e.type.replace(/_/g, ' ') };
  }
}

function AssetHistory({ deviceId }: { deviceId: string }) {
  const zone = useDeviceZone(deviceId);
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const events = useQuery(trpc.device.events.queryOptions({ orgId, deviceId, limit: 200 }));
  if (events.isPending) return <Skeleton className="h-24 w-full" />;
  if (events.isError) return <p className="text-sm text-destructive">{events.error.message}</p>;
  if (events.data.length === 0)
    return (
      <EmptyState
        icon={AlertTriangle}
        title="No history yet"
        description="Changes to this device are recorded here."
      />
    );
  // A serial change is recorded twice (the change, and the swap flag). Show the flag once.
  const flagged = new Set(
    events.data
      .filter((e) => e.type === 'swap_flagged')
      .map((e) => `${e.field}|${new Date(e.at).getTime()}`),
  );
  const shown = events.data.filter(
    (e) => !(e.type === 'field_changed' && flagged.has(`${e.field}|${new Date(e.at).getTime()}`)),
  );
  return (
    <ol className="relative space-y-4 border-l pl-5">
      {shown.map((e) => {
        const d = describe(e);
        return (
          <li key={e.id} className="relative">
            <span
              aria-hidden
              className={cn(
                'absolute top-1.5 -left-[1.6rem] size-2 rounded-full',
                d.tone === 'warn' ? 'bg-warning' : 'bg-muted-foreground/50',
              )}
            />
            <div className="text-sm font-medium">{d.title}</div>
            {d.detail && <div className="text-xs text-muted-foreground">{d.detail}</div>}
            <div className="text-xs text-muted-foreground" title={dateTime(e.at, zone)}>
              {timeAgo(e.at)}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const FIELD_TITLE: Record<string, string> = {
  online: 'Answering (availability)',
  power: 'Power',
  input: 'Input',
  muted: 'Muted',
  volume: 'Volume',
  blanked: 'Picture blanked',
  recording: 'Recording',
  occupied: 'Occupied',
  streamConnected: 'Receiving a stream',
  activeApp: 'Active app',
  playback: 'Playback',
  playSource: 'Playing from',
  inMeeting: 'In a meeting',
  roomState: 'Room state',
};

/** Charts for only the readings this device has reported: nothing is drawn for what it does not have. */
function DeviceHistoryCharts({ deviceId }: { deviceId: string }) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [days, setDays] = useState(7);
  const query = useQuery({
    ...trpc.roomUsage.device.queryOptions({ orgId, deviceId, days }),
    retry: false,
  });
  const history = query;
  const data = query.data;
  return (
    <div className="space-y-4">
      <SimpleSelect
        size="sm"
        className="w-36"
        value={String(days)}
        onValueChange={(v) => setDays(Number(v))}
        options={[
          { value: '1', label: 'Last 24 hours' },
          { value: '7', label: 'Last 7 days' },
          { value: '30', label: 'Last 30 days' },
          { value: '90', label: 'Last 90 days' },
        ]}
      />
      {history.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : history.isError ? (
        <p className="text-sm text-muted-foreground">History is not available on your plan.</p>
      ) : !data || data.series.length === 0 ? (
        <EmptyState
          icon={AlertTriangle}
          title="No readings yet"
          description="Charts appear here once the device has reported something to a gateway."
        />
      ) : (
        <>
          {data.availability !== null && (
            <p className="text-sm">
              Answering{' '}
              <span className="font-semibold">{Math.round(data.availability * 1000) / 10}%</span> of
              the time in this period.
            </p>
          )}
          {data.series.map((s) => (
            <Section key={s.field} title={FIELD_TITLE[s.field] ?? s.field}>
              <div className="p-4">
                {s.type === 'number' ? (
                  <LineSeries
                    points={s.points}
                    from={data.from}
                    to={data.to}
                    unit={s.field === 'volume' ? '' : undefined}
                  />
                ) : (
                  <StateStrip
                    points={s.points}
                    from={data.from}
                    to={data.to}
                    minutesByValue={s.minutesByValue}
                    goodValue={s.field === 'online' ? 'true' : undefined}
                  />
                )}
                <p className="mt-2 text-xs text-muted-foreground">
                  {s.points.length} change{s.points.length === 1 ? '' : 's'}
                  {s.type === 'state' && Object.keys(s.minutesByValue).length === 1
                    ? ` · ${minutesLabel(Object.values(s.minutesByValue)[0] ?? 0)} in one state`
                    : ''}
                </p>
              </div>
            </Section>
          ))}
        </>
      )}
    </div>
  );
}

function DeviceTickets({ deviceId }: { deviceId: string }) {
  const zone = useDeviceZone(deviceId);
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const tickets = useQuery(trpc.device.tickets.queryOptions({ orgId, deviceId }));
  if (tickets.isPending || !tickets.data || tickets.data.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Tickets about this device</h3>
      <ul className="divide-y rounded-lg border">
        {tickets.data.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <Link
              href={orgPath(orgId, `/tickets/${t.id}`)}
              className="text-sm font-medium hover:underline"
            >
              {t.title}
            </Link>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              {t.rootCause && <Badge variant="outline">{t.rootCause.replace(/_/g, ' ')}</Badge>}
              <Badge variant={t.status === 'open' ? 'default' : 'secondary'}>
                {t.status.replace('_', ' ')}
              </Badge>
              {dateTime(t.createdAt, zone)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeviceIncidents({ deviceId }: { deviceId: string }) {
  const zone = useDeviceZone(deviceId);
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const incidents = useQuery(trpc.device.incidents.queryOptions({ orgId, deviceId }));
  if (incidents.isPending) return <Skeleton className="h-24 w-full" />;
  if (incidents.isError)
    return <p className="text-sm text-destructive">{incidents.error.message}</p>;
  if (incidents.data.length === 0)
    return (
      <p className="text-sm text-muted-foreground">Nothing has been raised against this device.</p>
    );
  return (
    <ul className="divide-y rounded-lg border">
      {incidents.data.map((i) => (
        <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{i.title}</div>
            <div className="text-xs text-muted-foreground">
              Opened {dateTime(i.openedAt, zone)}
              {i.resolvedAt && <> · resolved {dateTime(i.resolvedAt, zone)}</>}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <SeverityPill severity={i.severity} />
            <Badge variant={i.status === 'open' ? 'default' : 'secondary'}>{i.status}</Badge>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---- Overview ----------------------------------------------------------------------------------

function Overview({ device }: { device: Device }) {
  const { orgId } = useOrg();
  const feedback = (device.feedback ?? {}) as Record<string, unknown>;
  const readings = Object.entries(feedback);
  const details = DeviceDetails.safeParse(device.details);
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border px-4 py-3">
          <div className="text-xs text-muted-foreground">State</div>
          <div className="mt-1">
            <DeviceStateBadge state={device.state} />
          </div>
          {device.since && device.state !== 'none' && (
            <div className="mt-0.5 text-xs text-muted-foreground">
              Since {timeAgo(device.since)}
            </div>
          )}
        </div>
        <div className="rounded-lg border px-4 py-3">
          <div className="text-xs text-muted-foreground">Room</div>
          <div className="mt-1 text-sm font-medium">
            {device.roomId ? (
              <Link href={orgPath(orgId, `/rooms/${device.roomId}`)} className="hover:underline">
                {device.roomName}
              </Link>
            ) : (
              <span className="text-muted-foreground">Not in a room</span>
            )}
          </div>
        </div>
        <div className="rounded-lg border px-4 py-3">
          <div className="text-xs text-muted-foreground">Gateway</div>
          <div className="mt-1 text-sm font-medium">
            {device.kind === 'passive' ? (
              <span className="text-muted-foreground">Not polled</span>
            ) : device.gatewayName ? (
              <>
                {device.gatewayName}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {device.gatewayStatus}
                  {device.gatewayOverride && ' · set on this device'}
                </span>
              </>
            ) : (
              <span className="text-warning">No gateway assigned</span>
            )}
          </div>
          {device.lastSeenAt && (
            <div className="mt-0.5 text-xs text-muted-foreground">
              Last heard {timeAgo(device.lastSeenAt)}
            </div>
          )}
        </div>
      </div>

      {device.kind === 'active' && (
        <Section title="Reading now">
          {readings.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">
              This device has not reported any readings.
            </p>
          ) : (
            <dl className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
              {readings.map(([k, v]) => (
                <div key={k} className="bg-background px-4 py-2.5">
                  <dt className="text-xs capitalize text-muted-foreground">
                    {k.replace(/([A-Z])/g, ' $1').toLowerCase()}
                  </dt>
                  <dd className="text-sm">{String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </Section>
      )}

      {details.success && details.data.length > 0 && (
        <Section title="What the device reports">
          <div className="p-4">
            <DeviceDetailsView details={details.data} />
          </div>
        </Section>
      )}
    </div>
  );
}

export function DeviceDetailView({ deviceId }: { deviceId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const { orgId, role, canSupport } = useOrg();
  const device = useQuery({
    ...trpc.device.get.queryOptions({ orgId, deviceId }),
    refetchInterval: 15_000,
  });
  const [deleting, setDeleting] = useState(false);
  const del = useMutation(
    trpc.device.delete.mutationOptions({
      onSuccess: async () => {
        toast.success('Device deleted');
        await qc.invalidateQueries({ queryKey: trpc.device.list.queryKey() });
        router.push(orgPath(orgId, '/assets'));
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (device.isPending)
    return (
      <PageContainer>
        <Skeleton className="h-32 w-full" />
      </PageContainer>
    );
  if (device.isError)
    return (
      <PageContainer>
        <p className="text-sm text-destructive">{device.error.message}</p>
      </PageContainer>
    );
  const d = device.data;
  const canDelete = role === 'owner' || role === 'dev';
  return (
    <PageContainer>
      <PageHeader
        title={d.name}
        description={`${assetCategoryLabel(d.category)}${d.roomName ? ` · ${d.roomName}` : ''}${d.kind === 'passive' ? ' · recorded only' : ''}`}
        actions={
          canDelete && (
            <Button variant="outline" size="sm" onClick={() => setDeleting(true)}>
              <Trash2 data-icon="inline-start" /> Delete
            </Button>
          )
        }
      />
      <SwapNotice device={d} />
      <AddressNotice device={d} />
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
          {d.kind === 'active' && <TabsTrigger value="points">Control points</TabsTrigger>}
          {d.kind === 'active' && <TabsTrigger value="charts">History</TabsTrigger>}
          {d.kind === 'active' && <TabsTrigger value="config">Configuration</TabsTrigger>}
          {d.kind === 'active' && <TabsTrigger value="settings">Settings</TabsTrigger>}
          <TabsTrigger value="maintenance">Maintenance</TabsTrigger>
          <TabsTrigger value="history">Asset history</TabsTrigger>
          <TabsTrigger value="incidents">Incidents and tickets</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="pt-4">
          <Overview device={d} />
        </TabsContent>
        {d.kind === 'active' && (
          <TabsContent value="settings" className="space-y-6 pt-4">
            <DeviceAddress key={`${d.id}:${d.version}`} device={d} />
            <DeviceSettings device={d} />
          </TabsContent>
        )}
        <TabsContent value="details" className="space-y-6 pt-4">
          <AssetDetails key={`${d.id}:${d.version}:${JSON.stringify(d.provenance)}`} device={d} />
          {!canSupport && (
            <Label className="text-xs text-muted-foreground">
              You can view but not change this device.
            </Label>
          )}
        </TabsContent>
        {d.kind === 'active' && (
          <TabsContent value="config" className="pt-4">
            <RequireFeature feature="configuration">
              <DeviceConfig deviceId={d.id} />
            </RequireFeature>
          </TabsContent>
        )}
        {d.kind === 'active' && (
          <TabsContent value="points" className="pt-4">
            <DevicePoints device={d} />
          </TabsContent>
        )}
        {d.kind === 'active' && (
          <TabsContent value="charts" className="space-y-6 pt-4">
            <DeviceResponse deviceId={d.id} />
            <DeviceHistoryCharts deviceId={d.id} />
          </TabsContent>
        )}
        <TabsContent value="maintenance" className="space-y-6 pt-4">
          <RequireFeature feature="maintenance">
            {d.kind === 'active' && (
              <section className="space-y-3">
                <h3 className="text-sm font-medium">Schedule</h3>
                <PmSchedules deviceId={d.id} compact />
              </section>
            )}
            <section className="space-y-3">
              <h3 className="text-sm font-medium">Visits</h3>
              <PmRuns deviceId={d.id} compact />
            </section>
          </RequireFeature>
        </TabsContent>
        <TabsContent value="history" className="pt-4">
          <AssetHistory deviceId={d.id} />
        </TabsContent>
        <TabsContent value="incidents" className="pt-4">
          <div className="space-y-6">
            <DeviceIncidents deviceId={d.id} />
            <DeviceTickets deviceId={d.id} />
          </div>
        </TabsContent>
      </Tabs>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${d.name}?`}
        description="Its record and history are removed. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => del.mutate({ orgId, deviceId: d.id })}
      />
    </PageContainer>
  );
}
