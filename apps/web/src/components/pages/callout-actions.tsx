'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { dateTime } from '@/components/common/health';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Callout = RouterOutputs['callout']['list']['callouts'][number];

/** A local date and time for the picker, from a Date. */
const local = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** Refreshes everything that shows a callout or its ticket. */
function useRefreshCallouts() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.callout.list.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.callout.forTicket.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.ticket.get.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.ticket.list.queryKey() }),
    ]);
}

function ScheduleDialog({ c, onClose }: { c: Callout; onClose: () => void }) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const refresh = useRefreshCallouts();
  const soon = new Date(Date.now() + 24 * 3_600_000);
  soon.setMinutes(0, 0, 0);
  const [start, setStart] = useState(local(c.scheduledFor ? new Date(c.scheduledFor) : soon));
  const [end, setEnd] = useState('');
  const [note, setNote] = useState('');
  const m = useMutation(
    trpc.callout.providerSchedule.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Visit scheduled. The customer is told on the ticket.');
        onClose();
      },
    }),
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate({
              orgId,
              calloutId: c.id,
              scheduledFor: new Date(start),
              scheduledEnd: end ? new Date(end) : null,
              note: note || undefined,
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Schedule the visit</DialogTitle>
            <DialogDescription>
              {c.title}. The time is written on the ticket for the customer. Nothing is charged
              through Kestrel.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ps-start">Arrives</Label>
              <Input
                id="ps-start"
                type="datetime-local"
                required
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ps-end">Finishes (optional)</Label>
              <Input
                id="ps-end"
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ps-note">Note to the customer (optional)</Label>
            <Textarea
              id="ps-note"
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {m.error && <p className="text-sm text-destructive">{m.error.message}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={m.isPending}>
              {m.isPending && <Spinner />}
              Schedule
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CompleteDialog({ c, onClose }: { c: Callout; onClose: () => void }) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const refresh = useRefreshCallouts();
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  const m = useMutation(
    trpc.callout.providerComplete.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Marked complete. It is written on the ticket.');
        onClose();
      },
    }),
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate({
              orgId,
              calloutId: c.id,
              actualHours: hours ? Number(hours) : null,
              note,
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Complete the callout</DialogTitle>
            <DialogDescription>
              {c.title}. What was done is kept on the callout and written on the ticket. Nothing is
              charged through Kestrel: invoice the customer yourselves.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="pc-hours">Hours worked (optional)</Label>
            <Input
              id="pc-hours"
              type="number"
              min={0.25}
              max={200}
              step={0.25}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pc-note">What was done (the customer sees this)</Label>
            <Textarea
              id="pc-note"
              required
              rows={3}
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {m.error && <p className="text-sm text-destructive">{m.error.message}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={m.isPending || !note.trim()}>
              {m.isPending && <Spinner />}
              Mark complete
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TransferDialog({
  c,
  to,
  onClose,
}: {
  c: Callout;
  to: 'kestrel' | 'provider';
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const refresh = useRefreshCallouts();
  const [note, setNote] = useState('');
  const target =
    to === 'kestrel' ? 'Kestrel' : (c.actions.coveringProviderName ?? 'the service provider');
  const m = useMutation(
    trpc.callout.transfer.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success(`Sent to ${target}. It is written on the ticket.`);
        onClose();
      },
    }),
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate({ orgId, calloutId: c.id, to, note: note || undefined });
          }}
        >
          <DialogHeader>
            <DialogTitle>Send to {target}?</DialogTitle>
            <DialogDescription>
              {c.title}. The ticket goes with it and the move is written on it.
              {c.routedTo === 'kestrel' && c.status === 'quoted'
                ? ' Kestrel’s quote is withdrawn, and the payment page for it is closed.'
                : ''}
              {c.status === 'scheduled' ? ' The scheduled visit is cleared.' : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="tr-note">Note (optional)</Label>
            <Textarea
              id="tr-note"
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {m.error && <p className="text-sm text-destructive">{m.error.message}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={m.isPending}>
              {m.isPending && <Spinner />}
              Send to {target}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What this person can do with a callout, as the server decided: the service provider that has it
 * schedules and completes it (and can hand it back to Kestrel); the organisation's owner or dev can
 * move it between Kestrel and the provider that covers it.
 */
export function CalloutActions({ c, size = 'sm' }: { c: Callout; size?: 'sm' | 'xs' }) {
  const [open, setOpen] = useState<null | 'schedule' | 'complete' | 'kestrel' | 'provider'>(null);
  const a = c.actions;
  if (!a.providerWork && !a.toKestrel && !a.toProvider) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {a.providerWork && (
        <>
          <Button size={size} onClick={() => setOpen('schedule')}>
            {c.status === 'scheduled' ? 'Change the visit' : 'Schedule a visit'}
          </Button>
          <Button size={size} variant="outline" onClick={() => setOpen('complete')}>
            Mark complete
          </Button>
        </>
      )}
      {a.toKestrel && (
        <Button size={size} variant="outline" onClick={() => setOpen('kestrel')}>
          {a.providerWork ? 'Hand back to Kestrel' : 'Send to Kestrel instead'}
        </Button>
      )}
      {a.toProvider && (
        <Button size={size} variant="outline" onClick={() => setOpen('provider')}>
          Send to {a.coveringProviderName} instead
        </Button>
      )}
      {open === 'schedule' && <ScheduleDialog c={c} onClose={() => setOpen(null)} />}
      {open === 'complete' && <CompleteDialog c={c} onClose={() => setOpen(null)} />}
      {(open === 'kestrel' || open === 'provider') && (
        <TransferDialog c={c} to={open} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

const WHO = (route: string | undefined, name: string | null) =>
  route === 'kestrel' ? 'Kestrel' : (name ?? 'the service provider');

/** Everything that has happened to a callout, oldest first. */
export function CalloutHistory({ c }: { c: Callout }) {
  if (c.history.length === 0) return null;
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">History ({c.history.length})</summary>
      <ul className="mt-1.5 space-y-1 border-l pl-3">
        {c.history.map((h, i) => (
          <li key={`${h.at}-${i}`}>
            <span className="tabular-nums">{dateTime(h.at, c.timezone)}</span>{' '}
            {h.kind === 'requested' && `Requested by ${h.by}.`}
            {h.kind === 'transferred' &&
              `Moved from ${WHO(h.from, h.from === c.routedTo ? c.providerName : null)} to ${WHO(h.to, h.to === c.routedTo ? c.providerName : null)} by ${h.by}.`}
            {h.kind === 'scheduled' && `${h.by} scheduled the visit.`}
            {h.kind === 'completed' && `${h.by} completed it.`}
            {h.note ? ` “${h.note}”` : ''}
          </li>
        ))}
      </ul>
    </details>
  );
}
