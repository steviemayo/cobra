'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, ClipboardCheck, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { INTERVAL_CHOICES, daysLate } from '@kestrel/model';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/format';
import { useEstate } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Schedule = RouterOutputs['pm']['schedules'][number];

const STATE_LABEL: Record<
  string,
  { label: string; variant: 'destructive' | 'default' | 'secondary' }
> = {
  overdue: { label: 'Overdue', variant: 'destructive' },
  due_soon: { label: 'Due soon', variant: 'default' },
  ok: { label: 'Scheduled', variant: 'secondary' },
};

const today = () => new Date().toISOString().slice(0, 10);

function NewScheduleDialog({
  roomId,
  deviceId,
  onClose,
}: {
  roomId?: string;
  deviceId?: string;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const { rooms } = useEstate();
  const templates = useQuery(trpc.pm.templates.queryOptions({ orgId }));
  const devices = useQuery(trpc.device.list.queryOptions({ orgId }));
  const usable = (templates.data ?? []).filter((t) =>
    roomId ? t.appliesTo === 'room' : deviceId ? t.appliesTo === 'device' : true,
  );
  const [templateId, setTemplateId] = useState('');
  const [target, setTarget] = useState(roomId ?? deviceId ?? '');
  const [interval, setIntervalDays] = useState(90);
  const [firstDue, setFirstDue] = useState(today());
  const template = usable.find((t) => t.id === templateId);
  const create = useMutation(
    trpc.pm.createSchedule.mutationOptions({
      onSuccess: async () => {
        toast.success('Schedule added');
        await qc.invalidateQueries({ queryKey: trpc.pm.schedules.queryKey() });
        await qc.invalidateQueries({ queryKey: trpc.monitoring.estate.queryKey() });
        onClose();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const targets =
    template?.appliesTo === 'device'
      ? (devices.data ?? [])
          .filter(
            (d) => d.kind === 'active' && (!template.category || d.category === template.category),
          )
          .map((d) => ({ value: d.id, label: `${d.name}${d.roomName ? ` (${d.roomName})` : ''}` }))
      : rooms.map((r) => ({ value: r.id, label: r.name }));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New maintenance schedule</DialogTitle>
          <DialogDescription>
            A check that comes round on its own, and shows as due soon and overdue.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Checklist</Label>
            <SimpleSelect
              value={templateId}
              onValueChange={(v) => {
                setTemplateId(v);
                if (!roomId && !deviceId) setTarget('');
              }}
              options={usable.map((t) => ({ value: t.id, label: t.name }))}
              placeholder="Choose a checklist"
            />
          </div>
          {template && (
            <div className="space-y-1.5">
              <Label className="text-xs">{template.appliesTo === 'room' ? 'Room' : 'Device'}</Label>
              <SimpleSelect
                value={target}
                disabled={!!(roomId ?? deviceId)}
                onValueChange={setTarget}
                options={targets}
                placeholder="Choose"
              />
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">How often</Label>
              <SimpleSelect
                value={String(interval)}
                onValueChange={(v) => setIntervalDays(Number(v))}
                options={INTERVAL_CHOICES.map((c) => ({ value: String(c.days), label: c.label }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">First due</Label>
              <Input
                type="date"
                value={firstDue}
                onChange={(e) => setFirstDue(e.target.value)}
                className="h-8"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!template || !target || create.isPending}
            onClick={() =>
              create.mutate({
                orgId,
                templateId,
                ...(template?.appliesTo === 'room' ? { roomId: target } : { deviceId: target }),
                intervalDays: interval,
                firstDueOn: new Date(firstDue),
              })
            }
          >
            Add schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Schedules for the organisation, a room or a device, with a button to start a visit. */
export function PmSchedules({
  roomId,
  deviceId,
  compact,
}: {
  roomId?: string;
  deviceId?: string;
  compact?: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const { orgId, canSupport } = useOrg();
  const list = useQuery(trpc.pm.schedules.queryOptions({ orgId, roomId, deviceId }));
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const start = useMutation(
    trpc.pm.startRun.mutationOptions({
      onSuccess: (r) => router.push(orgPath(orgId, `/pm/runs/${r.id}`)),
      onError: (e) => toast.error(e.message),
    }),
  );
  const del = useMutation(
    trpc.pm.deleteSchedule.mutationOptions({
      onSuccess: async () => {
        toast.success('Schedule removed');
        await qc.invalidateQueries({ queryKey: trpc.pm.schedules.queryKey() });
        await qc.invalidateQueries({ queryKey: trpc.monitoring.estate.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (list.isPending) return <Skeleton className="h-20 w-full" />;
  if (list.isError) return <p className="text-sm text-destructive">{list.error.message}</p>;
  const rows = [...list.data].sort(
    (a, b) => new Date(a.nextDueOn).getTime() - new Date(b.nextDueOn).getTime(),
  );
  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <EmptyState
          icon={CalendarCheck}
          title="Nothing scheduled"
          description="Add a schedule so maintenance checks come round on their own."
          action={
            canSupport ? <Button onClick={() => setAdding(true)}>New schedule</Button> : undefined
          }
          className={compact ? 'py-8' : undefined}
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {rows.map((s) => {
            const st = STATE_LABEL[s.state]!;
            const late = daysLate(new Date(s.nextDueOn), new Date());
            return (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {s.templateName}
                    <Badge variant={st.variant}>{st.label}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {!compact && (
                      <>
                        {s.roomId ? (
                          <Link
                            href={orgPath(orgId, `/rooms/${s.roomId}`)}
                            className="hover:underline"
                          >
                            {s.roomName}
                          </Link>
                        ) : (
                          <Link
                            href={orgPath(orgId, `/devices/${s.deviceId}`)}
                            className="hover:underline"
                          >
                            {s.deviceName}
                          </Link>
                        )}{' '}
                        ·{' '}
                      </>
                    )}
                    due {formatDate(s.nextDueOn)}
                    {s.state === 'overdue' && `, ${late} day${late === 1 ? '' : 's'} late`} · every{' '}
                    {INTERVAL_CHOICES.find((c) => c.days === s.intervalDays)?.label.toLowerCase() ??
                      `${s.intervalDays} days`}
                    {s.lastRunOn && ` · last done ${formatDate(s.lastRunOn)}`}
                  </div>
                </div>
                {canSupport && (
                  <div className="flex gap-2">
                    <Button
                      size="xs"
                      disabled={start.isPending}
                      onClick={() =>
                        start.mutate({ orgId, templateId: s.templateId, scheduleId: s.id })
                      }
                    >
                      <ClipboardCheck data-icon="inline-start" /> Start visit
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Remove schedule"
                      onClick={() => setDeleting(s)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canSupport && rows.length > 0 && (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus data-icon="inline-start" /> New schedule
        </Button>
      )}
      {adding && (
        <NewScheduleDialog roomId={roomId} deviceId={deviceId} onClose={() => setAdding(false)} />
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Remove this schedule?"
        description="Visits already signed off are kept."
        confirmLabel="Remove"
        destructive
        onConfirm={() => deleting && del.mutate({ orgId, scheduleId: deleting.id })}
      />
    </div>
  );
}

export function PmScheduleView() {
  return (
    <PageContainer>
      <PageHeader
        title="Maintenance schedule"
        description="Every planned check, with what is overdue or due soon. Start a visit to fill in its checklist and sign it off."
      />
      <PmSchedules />
    </PageContainer>
  );
}
