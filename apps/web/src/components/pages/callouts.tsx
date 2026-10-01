'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { dateTime } from '@/components/common/health';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
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
import { useRoomsOverview } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Callout = RouterOutputs['callout']['list']['callouts'][number];

const TONE: Record<string, string> = {
  quoted: 'border-primary text-primary',
  booked: 'border-primary bg-primary/10 text-primary',
  completed: 'text-muted-foreground',
  cancelled: 'text-muted-foreground',
  declined: 'text-muted-foreground',
};

function RequestDialog({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const rooms = useRoomsOverview();
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [roomId, setRoomId] = useState('none');
  const [preferred, setPreferred] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const create = useMutation(
    trpc.callout.request.mutationOptions({
      onSuccess: async () => {
        await qc.invalidateQueries({ queryKey: trpc.callout.list.queryKey() });
        toast.success('Callout requested. Kestrel will reply with availability and a quote.');
        onClose();
      },
    }),
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({
              orgId,
              title,
              details,
              roomId: roomId === 'none' ? null : roomId,
              preferredDates: preferred || null,
              contactName: contactName || null,
              contactPhone: contactPhone || null,
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Request a Kestrel callout</DialogTitle>
            <DialogDescription>
              A technician attends on site. Kestrel replies with availability and a quote. You pay
              up front to secure the booking, and can cancel for a full refund up to 48 hours
              before.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="co-title">What do you need?</Label>
            <Input
              id="co-title"
              required
              maxLength={120}
              placeholder="Replace the failed projector in Boardroom"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="co-details">
              What is wrong, and anything the technician should know
            </Label>
            <Textarea
              id="co-details"
              required
              rows={4}
              maxLength={4000}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Room (optional)</Label>
              <SimpleSelect
                className="w-full"
                value={roomId}
                onValueChange={setRoomId}
                options={[
                  { value: 'none', label: 'Not about one room' },
                  ...(rooms.data ?? []).map((r) => ({ value: r.id, label: r.name })),
                ]}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="co-when">Preferred times</Label>
              <Input
                id="co-when"
                maxLength={300}
                placeholder="Tuesday morning, before 10"
                value={preferred}
                onChange={(e) => setPreferred(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="co-name">Contact on the day</Label>
              <Input
                id="co-name"
                maxLength={100}
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="co-phone">Phone</Label>
              <Input
                id="co-phone"
                type="tel"
                maxLength={40}
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
              />
            </div>
          </div>
          {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !title.trim() || !details.trim()}>
              {create.isPending && <Spinner />}
              Send request
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Quote({ c }: { c: Callout }) {
  if (!c.totalCents || !c.hours || !c.rateCents) return null;
  return (
    <dl className="grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-0.5 text-sm">
      <dt className="text-muted-foreground">
        {c.hours} hours at {dollars(c.rateCents)}/hour
      </dt>
      <dd className="tabular-nums">{dollars(c.subtotalCents ?? 0)}</dd>
      <dt className="text-muted-foreground">GST (10%)</dt>
      <dd className="tabular-nums">{dollars(c.gstCents ?? 0)}</dd>
      <dt className="font-medium">Total (AUD)</dt>
      <dd className="font-medium tabular-nums">{dollars(c.totalCents)}</dd>
    </dl>
  );
}

function CalloutCard({
  c,
  noticeHours,
  paymentsAvailable,
}: {
  c: Callout;
  noticeHours: number;
  paymentsAvailable: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canEdit } = useOrg();
  const [cancelling, setCancelling] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.callout.list.queryKey() });
  const pay = useMutation(
    trpc.callout.pay.mutationOptions({
      onSuccess: (r) => {
        window.location.href = r.url;
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const cancel = useMutation(
    trpc.callout.cancel.mutationOptions({
      onSuccess: async (r) => {
        await refresh();
        toast.success(
          r.refundedCents > 0
            ? `Cancelled. ${dollars(r.refundedCents)} is being refunded.`
            : 'Cancelled.',
        );
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const open = ['requested', 'quoted', 'booked'].includes(c.status);
  return (
    <li className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{c.title}</div>
          <div className="text-xs text-muted-foreground">Requested {dateTime(c.createdAt, c.timezone)}</div>
        </div>
        <Badge variant="outline" className={TONE[c.status] ?? ''}>
          {c.statusLabel}
        </Badge>
      </div>
      <p className="whitespace-pre-line text-sm text-muted-foreground">{c.details}</p>

      {c.status === 'requested' && (
        <p className="text-sm text-muted-foreground">
          Kestrel will reply on{' '}
          {c.ticketId ? (
            <Link href={orgPath(orgId, `/tickets/${c.ticketId}`)} className="underline">
              the ticket
            </Link>
          ) : (
            'the ticket'
          )}{' '}
          with availability and a quote.
        </p>
      )}

      {c.status === 'quoted' && (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
          <p className="text-sm">
            Proposed time: <b>{c.scheduledFor ? dateTime(c.scheduledFor, c.timezone) : 'to be agreed'}</b>
          </p>
          <Quote c={c} />
          {c.quoteNote && <p className="text-sm text-muted-foreground">{c.quoteNote}</p>}
          <p className="text-xs text-muted-foreground">
            Payment up front secures the booking. Cancel at least {noticeHours} hours before for a
            full refund. The final cost follows the hours actually worked.
          </p>
          {canEdit && (
            <Button
              size="sm"
              disabled={pay.isPending || !paymentsAvailable}
              onClick={() => pay.mutate({ orgId, calloutId: c.id })}
            >
              {pay.isPending && <Spinner />}
              Accept and pay {dollars(c.totalCents ?? 0)}
            </Button>
          )}
          {!paymentsAvailable && (
            <p className="text-xs text-muted-foreground">
              Payments are not set up on this server yet.
            </p>
          )}
        </div>
      )}

      {c.status === 'booked' && (
        <div className="space-y-1 rounded-lg border bg-primary/5 p-3 text-sm">
          <p>
            Booked for <b>{c.scheduledFor ? dateTime(c.scheduledFor, c.timezone) : 'a time to be confirmed'}</b>
            . Paid {dollars(c.paidCents ?? 0)} including GST. A tax invoice was emailed to you.
          </p>
          <p className="text-xs text-muted-foreground">
            {c.refundOnCancel
              ? `Cancelling now refunds you in full (until ${noticeHours} hours before).`
              : `Inside ${noticeHours} hours of the booking the prepayment is not refunded automatically.`}
          </p>
        </div>
      )}

      {c.status === 'completed' && (
        <div className="space-y-1 text-sm">
          <p>
            Worked {c.actualHours} hours{c.hours ? ` (${c.hours} prepaid)` : ''}.
            {c.invoicedCents ? ` Invoice for the extra time: ${dollars(c.invoicedCents)}.` : ''}
            {c.refundedCents ? ` Refunded for unused time: ${dollars(c.refundedCents)}.` : ''}
          </p>
          {c.completionNote && <p className="text-muted-foreground">{c.completionNote}</p>}
          {c.invoiceUrl && (
            <a
              href={c.invoiceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              View invoice
            </a>
          )}
        </div>
      )}

      {c.status === 'cancelled' && (
        <p className="text-sm text-muted-foreground">
          Cancelled {c.cancelledAt ? dateTime(c.cancelledAt, c.timezone) : ''}
          {c.cancelledBy === 'staff' ? ' by Kestrel' : ''}.
          {c.refundedCents ? ` ${dollars(c.refundedCents)} refunded.` : ''}
          {c.paidAt && !c.refundedCents ? ' The prepayment was not refunded.' : ''}
        </p>
      )}

      {open && canEdit && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            disabled={cancel.isPending}
            onClick={() => setCancelling(true)}
          >
            Cancel callout
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        destructive
        title="Cancel this callout?"
        description={
          c.status === 'booked'
            ? c.refundOnCancel
              ? `You will be refunded ${dollars(c.paidCents ?? 0)} in full.`
              : `This is inside ${noticeHours} hours of the booking, so the prepayment is not refunded automatically.`
            : 'Nothing has been paid, so there is nothing to refund.'
        }
        confirmLabel="Cancel callout"
        onConfirm={() => cancel.mutate({ orgId, calloutId: c.id })}
      />
    </li>
  );
}

/** A customer's support callouts: ask for a technician, see the quote, pay to book, cancel. */
export function CalloutsView() {
  const trpc = useTRPC();
  const params = useSearchParams();
  const { orgId, canSupport } = useOrg();
  const [requesting, setRequesting] = useState(false);
  const q = useQuery({ ...trpc.callout.list.queryOptions({ orgId }), refetchInterval: 15_000 });
  useEffect(() => {
    if (params.get('paid') === '1')
      toast.success(
        'Payment received. Your booking is confirmed once Stripe tells us, usually within a minute.',
      );
  }, [params]);

  return (
    <PageContainer>
      <PageHeader
        title="Callouts"
        description="Ask for a Kestrel technician to attend on site. You get a quote, pay up front to book, and only pay for the hours worked."
        actions={
          canSupport && (
            <Button size="sm" onClick={() => setRequesting(true)}>
              <Wrench data-icon="inline-start" /> Request a callout
            </Button>
          )
        }
      />
      {q.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-destructive">{q.error.message}</p>
      ) : q.data.callouts.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title="No callouts yet"
          description="When something needs someone on site, request a callout and Kestrel will reply with availability and a price."
        />
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {q.data.callouts.map((c) => (
            <CalloutCard
              key={c.id}
              c={c}
              noticeHours={q.data.noticeHours}
              paymentsAvailable={q.data.paymentsAvailable}
            />
          ))}
        </ul>
      )}
      {requesting && <RequestDialog onClose={() => setRequesting(false)} />}
    </PageContainer>
  );
}
