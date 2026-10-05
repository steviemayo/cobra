'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, ChevronDown, ClipboardCheck, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { INTERVAL_CHOICES, daysLate } from '@kestrel/model';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { formatDate, plural } from '@/lib/format';
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

type ScopeKind = 'room' | 'rooms' | 'area' | 'site';

const SCOPE_CHOICES: { value: ScopeKind; label: string }[] = [
  { value: 'room', label: 'One room or device' },
  { value: 'rooms', label: 'Several rooms' },
  { value: 'area', label: 'An area (a building or level)' },
  { value: 'site', label: 'A whole site' },
];

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
  const { rooms, sites } = useEstate();
  const templates = useQuery(trpc.pm.templates.queryOptions({ orgId }));
  const devices = useQuery(trpc.device.list.queryOptions({ orgId }));
  const areas = useQuery(trpc.area.list.queryOptions({ orgId }));
  const fixed = !!(roomId ?? deviceId);
  const usable = (templates.data ?? []).filter((t) =>
    roomId ? t.appliesTo === 'room' : deviceId ? t.appliesTo === 'device' : true,
  );
  const [kind, setKind] = useState<ScopeKind>('room');
  const [templateId, setTemplateId] = useState('');
  const [target, setTarget] = useState(roomId ?? deviceId ?? '');
  const [siteId, setSiteId] = useState('');
  const [areaId, setAreaId] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  // A check is once-only unless someone chooses how often it comes round.
  const [interval, setIntervalDays] = useState(0);
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
  const siteName = (id: string) => sites.find((x) => x.id === id)?.name ?? '';
  const ready =
    !!template &&
    (kind === 'room'
      ? !!target
      : kind === 'rooms'
        ? picked.length >= 2
        : kind === 'area'
          ? !!areaId
          : !!siteId);
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
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
          {!fixed && (
            <div className="space-y-1.5">
              <Label className="text-xs">Covers</Label>
              <SimpleSelect
                value={kind}
                onValueChange={(v) => {
                  setKind(v);
                  setTarget('');
                }}
                options={SCOPE_CHOICES}
              />
              {kind !== 'room' && (
                <p className="text-xs text-muted-foreground">
                  One visit with a section for each room, signed off once. Each room keeps its own
                  answers, photos and tickets.
                </p>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs">Checklist</Label>
            <SimpleSelect
              value={templateId}
              onValueChange={(v) => {
                setTemplateId(v);
                if (!fixed) setTarget('');
              }}
              options={usable.map((t) => ({ value: t.id, label: t.name }))}
              placeholder="Choose a checklist"
            />
          </div>
          {template && kind === 'room' && (
            <div className="space-y-1.5">
              <Label className="text-xs">{template.appliesTo === 'room' ? 'Room' : 'Device'}</Label>
              <SimpleSelect
                value={target}
                disabled={fixed}
                onValueChange={setTarget}
                options={targets}
                placeholder="Choose"
              />
            </div>
          )}
          {template && kind === 'site' && (
            <div className="space-y-1.5">
              <Label className="text-xs">Site</Label>
              <SimpleSelect
                value={siteId}
                onValueChange={setSiteId}
                options={sites.map((x) => ({ value: x.id, label: x.name }))}
                placeholder="Choose a site"
              />
            </div>
          )}
          {template && kind === 'area' && (
            <div className="space-y-1.5">
              <Label className="text-xs">Area</Label>
              <SimpleSelect
                value={areaId}
                onValueChange={setAreaId}
                options={(areas.data ?? []).map((x) => ({
                  value: x.id,
                  label: `${siteName(x.siteId)} › ${x.name}`,
                }))}
                placeholder="Choose an area"
              />
              <p className="text-xs text-muted-foreground">Includes the areas inside it.</p>
            </div>
          )}
          {template && kind === 'rooms' && (
            <div className="space-y-1.5">
              <Label className="text-xs">Rooms ({picked.length} chosen, at least 2)</Label>
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                {rooms.map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={picked.includes(r.id)}
                      onCheckedChange={() => toggle(r.id)}
                    />
                    {r.name}
                    <span className="text-xs text-muted-foreground">{siteName(r.siteId)}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">How often</Label>
              <SimpleSelect
                value={String(interval)}
                onValueChange={(v) => setIntervalDays(Number(v))}
                options={[
                  { value: '0', label: 'One time only' },
                  ...INTERVAL_CHOICES.map((c) => ({ value: String(c.days), label: c.label })),
                ]}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{interval === 0 ? 'Due' : 'First due'}</Label>
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
            disabled={!ready || create.isPending}
            onClick={() =>
              create.mutate({
                orgId,
                templateId,
                ...(interval === 0 ? { oneOff: true } : { intervalDays: interval }),
                firstDueOn: new Date(firstDue),
                ...(kind === 'room'
                  ? template?.appliesTo === 'room'
                    ? { roomId: target }
                    : { deviceId: target }
                  : kind === 'site'
                    ? { scope: 'site' as const, siteId }
                    : kind === 'area'
                      ? { scope: 'area' as const, areaId }
                      : { scope: 'rooms' as const, roomIds: picked }),
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
  const [showLater, setShowLater] = useState(false);
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
  // A schedule repeats, so once its visit is signed off it moves on to the next due date. It stays
  // out of the way (under "Coming up") until it is due soon, overdue or has a visit under way.
  const needs = compact ? rows : rows.filter((s) => s.state !== 'ok' || s.openRunId);
  const later = compact ? [] : rows.filter((s) => s.state === 'ok' && !s.openRunId);
  const renderRow = (s: Schedule) => {
    const st = s.openRunId
      ? { label: 'In progress', variant: 'default' as const }
      : STATE_LABEL[s.state]!;
    const late = daysLate(new Date(s.nextDueOn), new Date());
    return (
      <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            {s.templateName}
            <Badge variant={st.variant}>{st.label}</Badge>
            {s.scope !== 'room' && (
              <Badge variant="outline">{plural(s.roomCount ?? 0, 'room')}</Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {!compact && (
              <>
                {s.scope !== 'room' ? (
                  s.scopeLabel
                ) : s.roomId ? (
                  <Link href={orgPath(orgId, `/rooms/${s.roomId}`)} className="hover:underline">
                    {s.roomName}
                  </Link>
                ) : (
                  <Link href={orgPath(orgId, `/devices/${s.deviceId}`)} className="hover:underline">
                    {s.deviceName}
                  </Link>
                )}{' '}
                ·{' '}
              </>
            )}
            {s.state === 'ok' && !s.openRunId && !s.oneOff ? 'next due ' : 'due '}
            {formatDate(s.nextDueOn)}
            {s.state === 'overdue' && `, ${late} day${late === 1 ? '' : 's'} late`} ·{' '}
            {s.oneOff
              ? 'one time only'
              : `every ${
                  INTERVAL_CHOICES.find((c) => c.days === s.intervalDays)?.label.toLowerCase() ??
                  `${s.intervalDays} days`
                }`}
            {s.lastRunOn && ` · last done ${formatDate(s.lastRunOn)}`}
          </div>
        </div>
        {canSupport && (
          <div className="flex gap-2">
            {s.openRunId ? (
              <Button size="xs" render={<Link href={orgPath(orgId, `/pm/runs/${s.openRunId}`)} />}>
                <ClipboardCheck data-icon="inline-start" /> Continue visit
              </Button>
            ) : (
              <Button
                size="xs"
                disabled={start.isPending}
                onClick={() => start.mutate({ orgId, templateId: s.templateId, scheduleId: s.id })}
              >
                <ClipboardCheck data-icon="inline-start" /> Start visit
              </Button>
            )}
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
  };
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
        <>
          {needs.length > 0 ? (
            <ul className="divide-y rounded-lg border">{needs.map(renderRow)}</ul>
          ) : (
            <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
              Nothing is due or under way. Done schedules wait below until their next visit is due
              soon.
            </p>
          )}
          {later.length > 0 && (
            <div className="space-y-2">
              <Button size="sm" variant="ghost" onClick={() => setShowLater(!showLater)}>
                <ChevronDown
                  data-icon="inline-start"
                  className={showLater ? 'rotate-180' : undefined}
                />
                Coming up ({later.length})
              </Button>
              {showLater && <ul className="divide-y rounded-lg border">{later.map(renderRow)}</ul>}
            </div>
          )}
        </>
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
