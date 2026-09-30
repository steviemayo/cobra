'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, Pencil } from 'lucide-react';
import { USAGE_KIND_LABEL, type UsageKind } from '@kestrel/model';
import { DailyBars, Heatmap, minutesLabel } from '@/components/common/usage-charts';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer } from '@/components/common/page-header';
import { Section } from '@/components/common/section';
import { SimpleSelect } from '@/components/common/simple-select';
import { useBilling } from '@/components/common/plan-gate';
import { useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/trpc/client';
import { useRoom } from './room-shell';
import { UsageDefinitionDialog } from './usage-definition-dialog';

const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);

function Kpi({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tabular mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** How one room is used: sessions, utilisation, busy hours, by the room's rule for "in use". */
export function RoomUsageView({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const { orgId, canSupport } = useOrg();
  const canDefine = useBilling().data?.entitlements.usageDefinitions ?? false;
  const { room } = useRoom(roomId);
  const [kind, setKind] = useState<UsageKind>('av');
  const [days, setDays] = useState(30);
  const [editing, setEditing] = useState(false);
  const usage = useQuery({
    ...trpc.roomUsage.room.queryOptions({ orgId, roomId, kind, days }),
    refetchInterval: 60_000,
    retry: false,
  });
  const devices = useQuery(trpc.device.list.queryOptions({ orgId, roomId }));

  return (
    <PageContainer className="pt-5">
      <div className="flex flex-wrap items-center gap-2">
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
        {usage.data && (
          <Badge variant={usage.data.inUseNow ? 'default' : 'secondary'}>
            {usage.data.inUseNow === null
              ? 'Not monitored'
              : usage.data.inUseNow
                ? 'In use now'
                : 'Not in use now'}
          </Badge>
        )}
        {canSupport && canDefine && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setEditing(true)}>
            <Pencil data-icon="inline-start" /> What counts as{' '}
            {kind === 'av' ? 'in use' : 'occupied'}
          </Button>
        )}
      </div>

      {usage.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : usage.isError ? (
        <EmptyState
          icon={BarChart3}
          title="Usage is not available"
          description="Your plan may not include analytics, or the room could not be read."
        />
      ) : usage.data.monitoredDevices === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="Nothing is monitored in this room"
          description="Usage comes from what devices report. Add a networked device with a driver to this room."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 divide-x divide-y overflow-hidden rounded-lg border sm:grid-cols-4 sm:divide-y-0">
            <Kpi
              label="Utilisation"
              value={pct(usage.data.utilisation)}
              hint="of working hours in use"
            />
            <Kpi
              label="Sessions"
              value={usage.data.summary.sessions}
              hint={`${minutesLabel(usage.data.summary.totalMinutes)} in total`}
            />
            <Kpi
              label="Average session"
              value={
                usage.data.summary.sessions ? minutesLabel(usage.data.summary.averageMinutes) : '–'
              }
              hint={
                usage.data.summary.sessions
                  ? `median ${minutesLabel(usage.data.summary.medianMinutes)}`
                  : undefined
              }
            />
            <Kpi
              label="Out of hours"
              value={minutesLabel(usage.data.summary.afterHoursMinutes)}
              hint="in use outside working time"
            />
          </div>
          <Section title="Time in use each day">
            <div className="p-4">
              <DailyBars days={usage.data.summary.days} />
            </div>
          </Section>
          <Section title="Busy hours">
            <div className="p-4">
              <Heatmap heat={usage.data.summary.heat} />
              <p className="mt-2 text-xs text-muted-foreground">
                Local time at the site ({usage.data.timeZone.replace(/_/g, ' ')}). Working hours are
                set under Room definitions.
              </p>
            </div>
          </Section>
        </>
      )}
      {editing && (
        <UsageDefinitionDialog
          roomId={roomId}
          roomName={room?.name}
          kind={kind}
          devices={(devices.data ?? []).map((d) => ({
            id: d.id,
            name: d.name,
            category: d.category,
          }))}
          onClose={() => setEditing(false)}
        />
      )}
    </PageContainer>
  );
}
