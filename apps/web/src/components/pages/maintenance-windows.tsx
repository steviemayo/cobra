'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarOff, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { dateTime } from '@/components/common/health';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
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
import { useEstate } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';

const SCOPES = [
  { value: 'org', label: 'Everything' },
  { value: 'site', label: 'A site' },
  { value: 'room', label: 'A room' },
  { value: 'device', label: 'A device' },
];
const REPEATS = [
  { value: 'none', label: 'Once' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
];

/** A local date and time for the picker, from a Date. */
const local = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function NewWindowDialog({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const { sites, rooms } = useEstate();
  const devices = useQuery(trpc.device.list.queryOptions({ orgId }));
  const soon = new Date(Date.now() + 3_600_000);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'org' | 'site' | 'room' | 'device'>('room');
  const [scopeId, setScopeId] = useState('');
  const [startsAt, setStartsAt] = useState(local(soon));
  const [endsAt, setEndsAt] = useState(local(new Date(soon.getTime() + 2 * 3_600_000)));
  const [repeat, setRepeat] = useState<'none' | 'daily' | 'weekly'>('none');
  const [reason, setReason] = useState('');
  const create = useMutation(
    trpc.support.createWindow.mutationOptions({
      onSuccess: async () => {
        toast.success(
          'Maintenance window added. Nothing new will alert or open a ticket during it.',
        );
        await qc.invalidateQueries({ queryKey: trpc.support.windows.queryKey() });
        onClose();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const targets =
    scope === 'site'
      ? sites.map((s) => ({ value: s.id, label: s.name }))
      : scope === 'room'
        ? rooms.map((r) => ({ value: r.id, label: r.name }))
        : scope === 'device'
          ? (devices.data ?? []).map((d) => ({ value: d.id, label: d.name }))
          : [];
  const valid = name.trim() && (scope === 'org' || scopeId) && startsAt && endsAt;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New maintenance window</DialogTitle>
          <DialogDescription>
            While a window is running, nothing it covers raises an incident, an alert or a ticket.
            Use it for planned work and technician visits.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Firmware update, Level 2"
              maxLength={80}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Covers</Label>
              <SimpleSelect
                value={scope}
                onValueChange={(v) => {
                  setScope(v as typeof scope);
                  setScopeId('');
                }}
                options={SCOPES}
              />
            </div>
            {scope !== 'org' && (
              <div className="space-y-1.5">
                <Label className="text-xs">Which</Label>
                <SimpleSelect
                  value={scopeId}
                  onValueChange={setScopeId}
                  options={targets}
                  placeholder="Choose"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">Starts</Label>
              <Input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                className="h-8"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Ends</Label>
              <Input
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                className="h-8"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Repeats</Label>
              <SimpleSelect
                value={repeat}
                onValueChange={(v) => setRepeat(v as typeof repeat)}
                options={REPEATS}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Reason (optional)</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid || create.isPending}
            onClick={() =>
              create.mutate({
                orgId,
                name: name.trim(),
                scope,
                scopeId: scope === 'org' ? null : scopeId,
                startsAt: new Date(startsAt),
                endsAt: new Date(endsAt),
                repeat,
                reason: reason || null,
              })
            }
          >
            Add window
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MaintenanceWindowsView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport } = useOrg();
  const windows = useQuery({
    ...trpc.support.windows.queryOptions({ orgId }),
    refetchInterval: 30_000,
  });
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const del = useMutation(
    trpc.support.deleteWindow.mutationOptions({
      onSuccess: async () => {
        toast.success('Window removed');
        await qc.invalidateQueries({ queryKey: trpc.support.windows.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <PageContainer>
      <PageHeader
        title="Maintenance windows"
        description="Times when a site, room or device should stay quiet: no incidents, alerts or tickets while planned work happens."
        actions={
          canSupport && (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus data-icon="inline-start" /> New window
            </Button>
          )
        }
      />
      {windows.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : windows.isError ? (
        <p className="text-sm text-destructive">{windows.error.message}</p>
      ) : windows.data.length === 0 ? (
        <EmptyState
          icon={CalendarOff}
          title="No maintenance windows"
          description="Add one before planned work so it does not raise alarms."
          action={
            canSupport ? <Button onClick={() => setAdding(true)}>New window</Button> : undefined
          }
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {windows.data.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  {w.name}
                  {w.active && <Badge>Running now</Badge>}
                  {w.repeat !== 'none' && (
                    <Badge variant="secondary">
                      {w.repeat === 'daily' ? 'Every day' : 'Every week'}
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {w.coversName} · {dateTime(w.startsAt)} to {dateTime(w.endsAt)}
                </div>
              </div>
              {canSupport && (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove ${w.name}`}
                  onClick={() => setDeleting({ id: w.id, name: w.name })}
                >
                  <Trash2 />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && <NewWindowDialog onClose={() => setAdding(false)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Remove ${deleting?.name}?`}
        description="Alerts and tickets are no longer held back for it."
        confirmLabel="Remove"
        destructive
        onConfirm={() => deleting && del.mutate({ orgId, windowId: deleting.id })}
      />
    </PageContainer>
  );
}
