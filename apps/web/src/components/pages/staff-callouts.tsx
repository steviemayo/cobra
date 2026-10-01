'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/common/empty-state';
import { dateTime } from '@/components/common/health';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { Badge } from '@/components/ui/badge';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { dollars } from '@/lib/money';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Row = RouterOutputs['staff']['callouts']['list']['callouts'][number];

const FILTERS = [
  { id: 'open', label: 'Needs action', status: ['requested', 'quoted', 'booked'] },
  { id: 'all', label: 'All', status: undefined },
] as const;

const LABEL: Record<string, string> = {
  requested: 'Needs a quote',
  quoted: 'Quoted, waiting for payment',
  booked: 'Booked and paid',
  completed: 'Completed',
  cancelled: 'Cancelled',
  declined: 'Declined',
};

/** A local date and time for the picker, from a Date. */
const local = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

type Action =
  | { kind: 'quote'; row: Row }
  | { kind: 'complete'; row: Row }
  | { kind: 'cancel'; row: Row }
  | { kind: 'decline'; row: Row };

function useRefresh() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: trpc.staff.callouts.list.queryKey() });
}

function QuoteDialog({
  row,
  defaultRateCents,
  onClose,
}: {
  row: Row;
  defaultRateCents: number | null;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const refresh = useRefresh();
  const soon = new Date(Date.now() + 3 * 86_400_000);
  soon.setHours(9, 0, 0, 0);
  const [hours, setHours] = useState(String(row.hours ?? 2));
  const [rate, setRate] = useState(
    row.rateCents
      ? String(row.rateCents / 100)
      : defaultRateCents
        ? String(defaultRateCents / 100)
        : '',
  );
  const [when, setWhen] = useState(local(row.scheduledFor ? new Date(row.scheduledFor) : soon));
  const [note, setNote] = useState(row.quoteNote ?? '');
  const quote = useMutation(
    trpc.staff.callouts.quote.mutationOptions({
      onSuccess: async (r) => {
        await refresh();
        toast.success(`Quote sent: ${dollars(r.totalCents)} including GST`);
        onClose();
      },
    }),
  );
  const h = Number(hours);
  const r = Math.round(Number(rate) * 100);
  const sub = Math.round(h * r);
  const gst = Math.round(sub * 0.1);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            quote.mutate({
              calloutId: row.id,
              hours: h,
              rateCents: r,
              scheduledFor: new Date(when),
              note: note || null,
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Quote: {row.title}</DialogTitle>
            <DialogDescription>
              {row.orgName}
              {row.preferredDates ? `. They asked for: ${row.preferredDates}` : ''}. The customer
              prepays the total through Stripe to secure the time.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="q-hours">Hours (half hours)</Label>
              <Input
                id="q-hours"
                type="number"
                min={0.5}
                max={40}
                step={0.5}
                required
                value={hours}
                onChange={(e) => setHours(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-rate">Rate per hour, excluding GST ($)</Label>
              <Input
                id="q-rate"
                type="number"
                min={1}
                step={0.01}
                required
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="q-when">Time offered</Label>
            <Input
              id="q-when"
              type="datetime-local"
              required
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="q-note">Note to the customer (optional)</Label>
            <Textarea
              id="q-note"
              rows={2}
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {Number.isFinite(sub) && sub > 0 && (
            <p className="rounded-lg border bg-muted/30 p-3 text-sm tabular-nums">
              {dollars(sub)} + GST {dollars(gst)} = <b>{dollars(sub + gst)}</b>
            </p>
          )}
          {quote.error && <p className="text-sm text-destructive">{quote.error.message}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={quote.isPending || !(sub > 0)}>
              {quote.isPending && <Spinner />}
              Send quote
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CompleteDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const trpc = useTRPC();
  const refresh = useRefresh();
  const [hours, setHours] = useState(String(row.hours ?? 1));
  const [note, setNote] = useState('');
  const done = useMutation(
    trpc.staff.callouts.complete.mutationOptions({
      onSuccess: async (r) => {
        await refresh();
        toast.success(
          r.diffCents > 0
            ? 'Completed. An invoice for the extra time was sent.'
            : r.diffCents < 0
              ? 'Completed. The unused time is being refunded.'
              : 'Completed.',
        );
        onClose();
      },
    }),
  );
  const rate = row.rateCents ?? 0;
  const prepaid = row.subtotalCents ?? 0;
  const diff = Math.round(Number(hours) * rate) - prepaid;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            done.mutate({ calloutId: row.id, actualHours: Number(hours), note: note || null });
          }}
        >
          <DialogHeader>
            <DialogTitle>Complete: {row.title}</DialogTitle>
            <DialogDescription>
              {row.hours} hours were prepaid at {dollars(rate)}/hour. Enter the hours actually
              worked: extra time is invoiced, unused time is credited and refunded.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="c-hours">Hours worked (half hours)</Label>
            <Input
              id="c-hours"
              type="number"
              min={0.5}
              max={40}
              step={0.5}
              required
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="c-note">What was done (the customer sees this)</Label>
            <Textarea
              id="c-note"
              rows={3}
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {Number.isFinite(diff) && (
            <p className="rounded-lg border bg-muted/30 p-3 text-sm tabular-nums">
              {diff > 0
                ? `Invoice for ${dollars(diff)} + GST ${dollars(Math.round(diff * 0.1))}`
                : diff < 0
                  ? `Refund ${dollars(-diff)} + GST ${dollars(Math.round(-diff * 0.1))} to the card`
                  : 'Nothing more to charge or refund'}
            </p>
          )}
          {done.error && <p className="text-sm text-destructive">{done.error.message}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={done.isPending}>
              {done.isPending && <Spinner />}
              Complete
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReasonDialog({
  row,
  mode,
  onClose,
}: {
  row: Row;
  mode: 'cancel' | 'decline';
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const refresh = useRefresh();
  const [reason, setReason] = useState('');
  const onSuccess = async () => {
    await refresh();
    toast.success(mode === 'cancel' ? 'Cancelled' : 'Declined');
    onClose();
  };
  const cancel = useMutation(trpc.staff.callouts.cancel.mutationOptions({ onSuccess }));
  const decline = useMutation(trpc.staff.callouts.decline.mutationOptions({ onSuccess }));
  const m = mode === 'cancel' ? cancel : decline;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            (mode === 'cancel' ? cancel : decline).mutate({ calloutId: row.id, reason });
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {mode === 'cancel' ? 'Cancel' : 'Decline'}: {row.title}
            </DialogTitle>
            <DialogDescription>
              {mode === 'cancel' && row.status === 'booked'
                ? `The customer is refunded ${dollars(row.paidCents ?? 0)} in full.`
                : 'The customer is told on the ticket.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="r-reason">Reason (the customer sees this)</Label>
            <Textarea
              id="r-reason"
              rows={3}
              maxLength={300}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {m.error && <p className="text-sm text-destructive">{m.error.message}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Back
            </Button>
            <Button type="submit" variant="destructive" disabled={m.isPending}>
              {m.isPending && <Spinner />}
              {mode === 'cancel' ? 'Cancel callout' : 'Decline'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Callouts across every organisation: quote, complete (invoice or refund), cancel. */
export function StaffCallouts() {
  const trpc = useTRPC();
  const refresh = useRefresh();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('open');
  const [action, setAction] = useState<Action | null>(null);
  const status = FILTERS.find((f) => f.id === filter)!.status;
  const q = useQuery({
    ...trpc.staff.callouts.list.queryOptions(status ? { status: [...status] } : {}),
    refetchInterval: 30_000,
  });
  const refund = useMutation(
    trpc.staff.callouts.refundLate.mutationOptions({
      onSuccess: async (r) => {
        await refresh();
        toast.success(`Refunded ${dollars(r.refundedCents)}`);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const chip = (active: boolean) =>
    cn(
      'rounded-full border px-3 py-1 text-xs',
      active ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground',
    );

  return (
    <PageContainer wide>
      <PageHeader
        title="Callouts"
        description="Requests for a technician on site. Quote, then complete with the hours worked."
      />
      <div className="flex gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={chip(filter === f.id)}
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {q.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-destructive">{q.error.message}</p>
      ) : q.data.callouts.length === 0 ? (
        <EmptyState icon={Wrench} title="Nothing here" />
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {q.data.callouts.map((c) => (
            <li key={c.id} className="space-y-2 px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium">{c.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {c.orgName}
                    {c.roomName ? ` · ${c.roomName}` : ''} · requested {dateTime(c.createdAt, c.timezone)}
                    {c.ticketId && (
                      <>
                        {' · '}
                        <Link href={`/staff/tickets/${c.ticketId}`} className="underline">
                          ticket
                        </Link>
                      </>
                    )}
                  </div>
                </div>
                <Badge variant="outline">{LABEL[c.status] ?? c.status}</Badge>
              </div>
              <p className="whitespace-pre-line text-sm text-muted-foreground">{c.details}</p>
              {c.preferredDates && <p className="text-sm">Preferred times: {c.preferredDates}</p>}
              {(c.contactName || c.contactPhone) && (
                <p className="text-sm text-muted-foreground">
                  Contact: {[c.contactName, c.contactPhone].filter(Boolean).join(', ')}
                </p>
              )}
              {c.totalCents ? (
                <p className="text-sm tabular-nums">
                  {c.hours} h at {dollars(c.rateCents ?? 0)} = {dollars(c.subtotalCents ?? 0)} + GST{' '}
                  {dollars(c.gstCents ?? 0)} = <b>{dollars(c.totalCents)}</b>
                  {c.scheduledFor ? ` · ${dateTime(c.scheduledFor, c.timezone)}` : ''}
                  {c.paidAt ? ' · paid' : ''}
                </p>
              ) : null}
              {c.status === 'completed' && (
                <p className="text-sm text-muted-foreground">
                  Worked {c.actualHours} h.
                  {c.invoicedCents ? ` Invoiced ${dollars(c.invoicedCents)}.` : ''}
                  {c.refundedCents ? ` Refunded ${dollars(c.refundedCents)}.` : ''}
                </p>
              )}
              {c.status === 'cancelled' && (
                <p className="text-sm text-muted-foreground">
                  Cancelled by {c.cancelledBy}
                  {c.cancelReason ? `: ${c.cancelReason}` : ''}.
                  {c.refundedCents ? ` Refunded ${dollars(c.refundedCents)}.` : ''}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {(c.status === 'requested' || c.status === 'quoted') && (
                  <Button size="sm" onClick={() => setAction({ kind: 'quote', row: c })}>
                    {c.status === 'quoted' ? 'Change quote' : 'Send quote'}
                  </Button>
                )}
                {c.status === 'booked' && (
                  <Button size="sm" onClick={() => setAction({ kind: 'complete', row: c })}>
                    Complete
                  </Button>
                )}
                {(c.status === 'requested' || c.status === 'quoted') && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setAction({ kind: 'decline', row: c })}
                  >
                    Decline
                  </Button>
                )}
                {['requested', 'quoted', 'booked'].includes(c.status) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setAction({ kind: 'cancel', row: c })}
                  >
                    Cancel
                  </Button>
                )}
                {c.status === 'cancelled' &&
                  c.cancelledBy === 'customer' &&
                  c.paidAt &&
                  !c.refundedCents && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={refund.isPending}
                      onClick={() => refund.mutate({ calloutId: c.id })}
                    >
                      Refund late cancellation
                    </Button>
                  )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {action?.kind === 'quote' && (
        <QuoteDialog
          row={action.row}
          defaultRateCents={q.data?.defaultRateCents ?? null}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'complete' && (
        <CompleteDialog row={action.row} onClose={() => setAction(null)} />
      )}
      {(action?.kind === 'cancel' || action?.kind === 'decline') && (
        <ReasonDialog row={action.row} mode={action.kind} onClose={() => setAction(null)} />
      )}
    </PageContainer>
  );
}
