'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  LifeBuoy,
  PlayCircle,
  Power,
  RotateCw,
  Search,
  Stethoscope,
} from 'lucide-react';
import { toast } from 'sonner';
import { AnimatedCollapse } from '@/components/common/animated-collapse';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { useBilling } from '@/components/common/plan-gate';
import {
  HealthPill,
  INCIDENT_KIND_LABEL,
  OnlineDot,
  SeverityPill,
  dateTime,
} from '@/components/common/health';
import { PageContainer } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { COMMAND_INFO, type CommandType, type DeviceFeedback } from '@kestrel/model';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';
import { NewTicketDialog } from './tickets';

type Command = RouterOutputs['command']['list'][number];

// Whatever the device's own driver reports back, in a few plain words. Works whether or not the
// room has control: this is read-only feedback, never a sign that anything can be changed here.
function feedbackChips(f: DeviceFeedback | null | undefined): string[] {
  if (!f) return [];
  const chips: string[] = [];
  if (f.power) chips.push(f.power === 'on' ? 'On' : f.power === 'off' ? 'Off' : f.power);
  if (f.input) chips.push(f.input);
  if (f.muted) chips.push('Muted');
  if (f.volume !== undefined) chips.push(`Vol ${f.volume}`);
  if (f.blanked) chips.push('Blanked');
  if (f.recording) chips.push('Recording');
  if (f.occupied) chips.push('Occupied');
  if (f.streamConnected !== undefined)
    chips.push(f.streamConnected ? 'Stream connected' : 'Stream not connected');
  if (f.activeApp) chips.push(f.activeApp);
  return chips;
}

function minutesLabel(m: number): string {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

/**
 * How long a feedback field held each value over the last 30 days, from the changes Kestrel has
 * logged — the same feedback whether the room has control or not. Says nothing while there is
 * nothing yet to show, rather than an empty "Last 30 days:".
 */
function DeviceHistoryLine({
  orgId,
  roomId,
  deviceId,
  field,
}: {
  orgId: string;
  roomId: string;
  deviceId: string;
  field: 'power' | 'input' | 'online';
}) {
  const trpc = useTRPC();
  const history = useQuery({
    ...trpc.monitoring.deviceHistory.queryOptions({ orgId, roomId, deviceId, field, days: 30 }),
    staleTime: 5 * 60_000,
  });
  const durations = history.data?.durations ?? [];
  if (durations.length === 0) return null;
  // "online" reuses the on/off wording durationsByValue gives any boolean; say what it means here.
  const show = (v: string) => (field === 'online' ? (v === 'on' ? 'Online' : 'Offline') : v);
  return (
    <span className="text-xs text-muted-foreground">
      Last 30 days: {durations.map((d) => `${show(d.value)} ${minutesLabel(d.minutes)}`).join(', ')}
      {history.data?.truncated && ' (partial)'}
    </span>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-4 py-2.5">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

// Plain wording for what a gateway told us happened.
function describeEvent(type: string, data: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (type) {
    case 'device.offline':
      return `${s(data.name) || 'A device'} stopped answering`;
    case 'device.online':
      return `${s(data.name) || 'A device'} is back`;
    case 'room.status':
      return `Room is now ${s(data.status)}`;
    case 'room.occupancy':
      return data.occupied ? 'Someone is in the room' : 'The room is empty';
    case 'activity.started':
      return `Activity started (${s(data.activityId)})`;
    case 'activity.stopped':
      return `Activity stopped (${s(data.activityId)})`;
    case 'device.fault':
      return 'A device fault stopped the room';
    case 'manifest.rejected':
      return `A release was refused: ${s(data.problem)}`;
    case 'command.finished':
      return `Remote command ${s(data.type)} ${data.ok ? 'finished' : 'failed'}`;
    default:
      return type;
  }
}

const COMMAND_ICON: Record<CommandType, typeof Power> = {
  diagnostics: Stethoscope,
  test_device: PlayCircle,
  restart_room: RotateCw,
  room_off: Power,
  verify_point: Stethoscope,
  discover_devices: Search,
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting for the gateway',
  sent: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  expired: 'Timed out',
};

function CommandRow({ c }: { c: Command }) {
  const [open, setOpen] = useState(false);
  const info = COMMAND_INFO[c.type as CommandType];
  const running = c.status === 'pending' || c.status === 'sent';
  const hasOutput = c.output && Object.keys(c.output).length > 0;
  return (
    <li className="px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-sm">
          <span className="font-medium">{info?.label ?? c.type}</span>
          {c.args.deviceId && <span className="text-muted-foreground"> · {c.args.deviceId}</span>}
          <span className="text-muted-foreground">
            {' '}
            · {c.requestedBy} · {timeAgo(c.createdAt)}
          </span>
        </div>
        <span className="inline-flex items-center gap-2 text-sm">
          <span
            aria-hidden
            className={cn(
              'size-2 rounded-full',
              c.status === 'succeeded'
                ? 'bg-success'
                : running
                  ? 'animate-pulse bg-warning'
                  : 'bg-destructive',
            )}
          />
          {STATUS_LABEL[c.status] ?? c.status}
        </span>
      </div>
      {c.error && <p className="mt-1 text-sm text-muted-foreground">{c.error}</p>}
      {hasOutput && (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronRight
              className={cn('size-3.5 transition-transform duration-200', open && 'rotate-90')}
            />
            Details
          </button>
          <AnimatedCollapse open={open}>
            <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(c.output, null, 2)}
            </pre>
          </AnimatedCollapse>
        </>
      )}
    </li>
  );
}

export function RoomMonitoring({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport } = useOrg();
  const [restarting, setRestarting] = useState(false);
  const [raising, setRaising] = useState(false);
  const overview = useQuery({
    ...trpc.monitoring.overview.queryOptions({ orgId }),
    refetchInterval: 5_000,
  });
  const detail = useQuery({
    ...trpc.monitoring.room.queryOptions({ orgId, roomId }),
    refetchInterval: 5_000,
  });
  const commands = useQuery({
    ...trpc.command.list.queryOptions({ orgId, roomId }),
    enabled: canSupport,
    refetchInterval: (q) =>
      q.state.data?.some((c) => c.status === 'pending' || c.status === 'sent') ? 2_000 : 15_000,
  });

  // Ended trial: analytics is off, so no history query gets sent.
  const analytics = useBilling().data?.entitlements.analytics ?? true;
  const room = overview.data?.rooms.find((r) => r.id === roomId);
  const run = useMutation(
    trpc.command.request.mutationOptions({
      onSuccess: async () => {
        await qc.invalidateQueries({ queryKey: trpc.command.list.queryKey() });
        toast.success('Sent to the gateway');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const send = (type: CommandType, deviceId?: string) =>
    run.mutate({ orgId, roomId, type, ...(deviceId ? { deviceId } : {}) });
  const noGateway = !!room && room.gatewayStatus !== 'online';

  if (overview.isPending || detail.isPending)
    return (
      <PageContainer>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </PageContainer>
    );
  if (!room || !detail.data) return null;
  const d = detail.data;

  return (
    <PageContainer>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3">
        <div className="space-y-1">
          <HealthPill
            level={room.health.level}
            reasons={room.health.reasons}
            className="text-base font-medium"
          />
          <p className="text-sm text-muted-foreground">
            {room.health.reasons[0] ?? 'Everything this room reports is fine.'}
            {room.reportedAt && ` Last heard ${timeAgo(room.reportedAt)}.`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setRaising(true)}>
          <LifeBuoy data-icon="inline-start" /> Get help
        </Button>
      </div>

      <Section title="Devices">
        {d.devices.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            No device status yet. It appears once the gateway running this room reports in.
          </p>
        ) : (
          <ul className="divide-y">
            {d.devices.map((dev) => (
              <li key={dev.deviceId} className="flex flex-col gap-1.5 px-4 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2.5 text-sm">
                    <OnlineDot online={dev.online} />
                    <span className="font-medium">{dev.name}</span>
                    {dev.firmware && (
                      <span className="text-xs text-muted-foreground">Firmware {dev.firmware}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-3 text-sm text-muted-foreground">
                    {dev.online ? 'Online' : 'Offline'} since {timeAgo(dev.since)}
                    {canSupport && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={run.isPending || noGateway}
                        onClick={() => send('test_device', dev.deviceId)}
                      >
                        Test
                      </Button>
                    )}
                  </span>
                </div>
                {feedbackChips(dev.feedback).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pl-6">
                    {feedbackChips(dev.feedback).map((chip) => (
                      <span
                        key={chip}
                        className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                      >
                        {chip}
                      </span>
                    ))}
                  </div>
                )}
                {analytics && (
                  <div className="flex flex-col gap-0.5 pl-6">
                    <DeviceHistoryLine
                      orgId={orgId}
                      roomId={roomId}
                      deviceId={dev.deviceId}
                      field="online"
                    />
                    {dev.feedback?.power !== undefined && (
                      <DeviceHistoryLine
                        orgId={orgId}
                        roomId={roomId}
                        deviceId={dev.deviceId}
                        field="power"
                      />
                    )}
                    {dev.feedback?.input !== undefined && (
                      <DeviceHistoryLine
                        orgId={orgId}
                        roomId={roomId}
                        deviceId={dev.deviceId}
                        field="input"
                      />
                    )}
                    <Link
                      href={`${orgPath(orgId, `/rooms/${roomId}/monitoring/history`)}?device=${dev.deviceId}&name=${encodeURIComponent(dev.name)}&field=${dev.feedback?.power !== undefined ? 'power' : dev.feedback?.input !== undefined ? 'input' : 'online'}`}
                      className="self-start text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      Chart this device’s history →
                    </Link>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {canSupport && (
        <Section title="Support tools">
          <div className="space-y-3 p-4">
            <div className="flex flex-wrap gap-2">
              {(['diagnostics', 'room_off', 'restart_room'] as const).map((type) => {
                const Icon = COMMAND_ICON[type];
                return (
                  <Button
                    key={type}
                    variant="outline"
                    size="sm"
                    disabled={run.isPending || noGateway}
                    title={COMMAND_INFO[type].description}
                    onClick={() => (type === 'restart_room' ? setRestarting(true) : send(type))}
                  >
                    {run.isPending && run.variables?.type === type ? (
                      <Spinner />
                    ) : (
                      <Icon data-icon="inline-start" />
                    )}
                    {COMMAND_INFO[type].label}
                  </Button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              {noGateway
                ? 'The gateway is not online, so commands can’t be sent right now.'
                : 'The gateway picks these up within about half a minute. Only these actions are allowed, and each one is logged.'}
            </p>
          </div>
          {commands.data && commands.data.length > 0 && (
            <ul className="divide-y border-t">
              {commands.data.map((c) => (
                <CommandRow key={c.id} c={c} />
              ))}
            </ul>
          )}
        </Section>
      )}

      <Section title="Incidents">
        {d.incidents.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">No incidents for this room.</p>
        ) : (
          <ul className="divide-y">
            {d.incidents.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium">{i.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {INCIDENT_KIND_LABEL[i.kind] ?? i.kind} · {dateTime(i.openedAt)}
                    {i.resolvedAt ? ` · resolved ${dateTime(i.resolvedAt)}` : ' · still open'}
                  </div>
                </div>
                <SeverityPill severity={i.severity} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Recent activity"
        action={
          <Link
            href={orgPath(orgId, '/incidents')}
            className="text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            All incidents
          </Link>
        }
      >
        {d.events.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Nothing reported yet.</p>
        ) : (
          <ul className="divide-y">
            {d.events.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <span>{describeEvent(e.type, e.data)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{dateTime(e.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <ConfirmDialog
        open={restarting}
        onOpenChange={setRestarting}
        title="Restart this room?"
        description="The room reloads its running release and reconnects every device. It goes back to off, so don’t do this while a meeting is on."
        confirmLabel="Restart room"
        destructive
        onConfirm={() => send('restart_room')}
      />
      {raising && <NewTicketDialog open onOpenChange={setRaising} defaults={{ roomId }} />}
    </PageContainer>
  );
}
