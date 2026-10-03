'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  PAID_PLANS,
  PLAN_FEATURES,
  PLAN_LABEL,
  type BillingInterval,
  type PaidPlan,
} from '@kestrel/model';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { formatDate, plural } from '@/lib/format';
import { formatMoney } from '@/lib/plan-price-format';
import { useTRPC } from '@/trpc/client';

/**
 * A provider's side of delegated billing, on its own billing page: customers asking it to pay, the
 * customers it pays for, and whether it can pay at all (BD-5 to BD-8). Nothing shows until there is
 * a request or a customer, so ordinary organisations never see it.
 */
export function ProviderBillingInbox() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const inbox = useQuery({ ...trpc.billing.delegationInbox.queryOptions({ orgId }), retry: false });
  const prices = useQuery(trpc.billing.prices.queryOptions({ orgId }));
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.billing.delegationInbox.queryKey() });
  const setup = useMutation(
    trpc.billing.setupPayment.mutationOptions({
      onSuccess: (res) => window.location.assign(res.url),
      onError: (e) => toast.error(e.message),
    }),
  );

  if (inbox.isPending) return <Skeleton className="h-24 w-full" />;
  const data = inbox.data;
  if (!data || (!data.requests.length && !data.customers.length)) return null;

  return (
    <section className="space-y-4 rounded-lg border p-4" aria-label="Billing for your customers">
      <div>
        <div className="text-sm font-medium">Billing for your customers</div>
        <p className="text-sm text-muted-foreground">
          You pay Kestrel for the customers listed here and bill them yourself. Their price is the
          same as everyone’s
          {data.discountPercent ? `, less your ${data.discountPercent}% discount` : ''}.
        </p>
      </div>

      {!data.readiness.ok && (
        <div className="space-y-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
          <p>{data.readiness.reason}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={setup.isPending}
            onClick={() => setup.mutate({ orgId })}
          >
            {setup.isPending && <Spinner />}
            Add a payment method
          </Button>
        </div>
      )}

      {data.requests.length > 0 && (
        <div className="space-y-3">
          <div className="text-sm font-medium">Waiting for you</div>
          {data.requests.map((r) => (
            <RequestRow
              key={r.orgId}
              request={r}
              canPay={data.readiness.ok}
              invoiced={!!data.readiness.invoiced}
              yearlyAvailable={data.yearlyAvailable}
              prices={prices.data ?? []}
              onDone={refresh}
            />
          ))}
        </div>
      )}

      {data.customers.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium">Customers you pay for</div>
          {data.customers.map((c) => (
            <CustomerRow key={c.orgId} customer={c} onDone={refresh} />
          ))}
        </div>
      )}
    </section>
  );
}

type Price = { plan: PaidPlan; interval: BillingInterval; unitAmount: number; currency: string };

function RequestRow({
  request,
  canPay,
  invoiced,
  yearlyAvailable,
  prices,
  onDone,
}: {
  request: { orgId: string; orgName: string; requestedAt: Date | null; rooms: number };
  canPay: boolean;
  invoiced: boolean;
  yearlyAvailable: boolean;
  prices: Price[];
  onDone: () => unknown;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [plan, setPlan] = useState<PaidPlan>('basic');
  const [interval, setInterval] = useState<BillingInterval>(invoiced ? 'year' : 'month');
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [declining, setDeclining] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const accept = useMutation(
    trpc.billing.acceptDelegation.mutationOptions({
      onSuccess: async (res) => {
        setConfirm(false);
        await onDone();
        toast.success(
          res.handoverAt
            ? `Accepted. Your billing starts on ${formatDate(res.handoverAt)}, when their own subscription ends.`
            : 'Accepted. You now pay Kestrel for this customer.',
        );
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const decline = useMutation(
    trpc.billing.declineDelegation.mutationOptions({
      onSuccess: async () => {
        await onDone();
        toast.message('Declined. They have been told why.');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const unit = prices.find((p) => p.plan === plan && p.interval === interval);
  const rooms = Math.max(1, request.rooms);
  const label = PLAN_FEATURES[plan].label;
  const cost = unit
    ? `${formatMoney(unit.unitAmount * rooms, unit.currency)} per ${interval === 'year' ? 'year' : 'month'} before any discount`
    : 'Price on request';

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-medium">{request.orgName}</div>
        <div className="text-sm text-muted-foreground">
          {plural(request.rooms, 'monitored room')}
          {request.requestedAt ? `, asked ${formatDate(request.requestedAt)}` : ''}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm">
          <span className="block text-muted-foreground">Plan</span>
          <SimpleSelect
            className="w-40"
            value={plan}
            onValueChange={setPlan}
            options={PAID_PLANS.map((p) => ({ value: p, label: PLAN_LABEL[p] }))}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block text-muted-foreground">Billed</span>
          <SimpleSelect
            className="w-36"
            value={interval}
            onValueChange={setInterval}
            options={[
              { value: 'month', label: 'Monthly', disabled: invoiced },
              { value: 'year', label: 'Yearly', disabled: !yearlyAvailable },
            ]}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block text-muted-foreground">Discount code (optional)</span>
          <Input
            className="w-44"
            maxLength={64}
            value={code}
            onChange={(ev) => setCode(ev.target.value)}
          />
        </label>
      </div>
      <p className="text-sm text-muted-foreground">
        {label}: {cost}.
        {invoiced && ' Your organisation is invoiced yearly, so customers are billed yearly too.'}
      </p>
      {declining ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="max-w-sm"
            aria-label="Reason shown to the customer"
            placeholder="Reason, shown to the customer"
            maxLength={500}
            value={reason}
            onChange={(ev) => setReason(ev.target.value)}
          />
          <Button
            size="sm"
            variant="destructive"
            disabled={decline.isPending || reason.trim().length < 5}
            onClick={() =>
              decline.mutate({ orgId, customerOrgId: request.orgId, reason: reason.trim() })
            }
          >
            {decline.isPending && <Spinner />}
            Decline
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDeclining(false)}>
            Back
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!canPay || accept.isPending} onClick={() => setConfirm(true)}>
            {accept.isPending && <Spinner />}
            Accept and pay for {request.orgName}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDeclining(true)}>
            Decline
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Pay for ${request.orgName}?`}
        confirmLabel="Accept"
        description={`${label}, ${interval === 'year' ? 'yearly' : 'monthly'}, for ${plural(
          request.rooms,
          'room',
        )}. ${cost}. Kestrel charges your payment method; you bill ${request.orgName} yourself. If they have a subscription of their own, yours starts charging when it ends.`}
        onConfirm={() =>
          accept.mutate({
            orgId,
            customerOrgId: request.orgId,
            plan,
            interval,
            ...(code.trim() ? { code: code.trim() } : {}),
          })
        }
      />
    </div>
  );
}

function CustomerRow({
  customer: c,
  onDone,
}: {
  customer: {
    orgId: string;
    orgName: string;
    plan: string;
    interval: string;
    rooms: number;
    status: 'active' | 'ending';
    handoverAt: Date | null;
    endsAt: Date | null;
  };
  onDone: () => unknown;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [confirm, setConfirm] = useState(false);
  const end = useMutation(
    trpc.billing.endDelegationAsProvider.mutationOptions({
      onSuccess: async (res) => {
        setConfirm(false);
        await onDone();
        toast.success(
          res.outcome === 'stopped'
            ? 'Done. Your billing for this customer never started, so they pay Kestrel directly as before.'
            : 'Done. You will stop paying for this customer at the end of the period.',
        );
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const planLabel = c.plan === 'pro' ? 'Premium' : c.plan === 'basic' ? 'Essentials' : c.plan;
  const note =
    c.status === 'ending'
      ? `ending ${c.endsAt ? formatDate(c.endsAt) : 'at the end of the period'}`
      : c.handoverAt && c.handoverAt > new Date()
        ? `starts charging ${formatDate(c.handoverAt)}`
        : 'active';
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
      <div>
        <div className="font-medium">{c.orgName}</div>
        <div className="text-muted-foreground">
          {planLabel}, {c.interval === 'year' ? 'yearly' : 'monthly'}, {plural(c.rooms, 'room')},{' '}
          {note}
        </div>
      </div>
      {c.status === 'active' && (
        <Button
          size="sm"
          variant="outline"
          disabled={end.isPending}
          onClick={() => setConfirm(true)}
        >
          {end.isPending && <Spinner />}
          Stop paying
        </Button>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Stop paying for ${c.orgName}?`}
        destructive
        confirmLabel="Stop paying"
        description={`${c.orgName} is told and has until the end of the current period to set up direct billing. After that their account drops to monitoring only.`}
        onConfirm={() => end.mutate({ orgId, customerOrgId: c.orgId })}
      />
    </div>
  );
}
