'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { toast } from 'sonner';
import {
  PAID_PLANS,
  PLAN_FEATURES,
  PLAN_LABEL,
  type BillingInterval,
  type PaidPlan,
} from '@kestrel/model';

import { useBilling } from '@/components/common/plan-gate';
import { ProviderBillingInbox } from '@/components/pages/billing-provider-inbox';
import { WhoPays } from '@/components/pages/billing-who-pays';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { formatDate, plural } from '@/lib/format';
import { formatMoney, perMonthFromYear, taxNote } from '@/lib/plan-price-format';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';

export function BillingView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const { orgId, isOwner } = useOrg();
  const billing = useBilling();
  const [pickedInterval, setPickedInterval] = useState<BillingInterval | null>(null);
  const [anchor, setAnchor] = useState(false);
  // Rooms typed into the cost estimate; empty means "my own rooms".
  const [roomsInput, setRoomsInput] = useState('');
  const prices = useQuery(trpc.billing.prices.queryOptions({ orgId }));

  useEffect(() => {
    if (!isOwner) router.replace(orgPath(orgId, '/settings/activity'));
  }, [isOwner, orgId, router]);

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('checkout');
    if (result === 'success') toast.success('Thanks! Your plan updates in a moment.');
    if (result === 'cancelled') toast.message('Checkout cancelled. You haven’t been charged.');
    const setup = new URLSearchParams(window.location.search).get('setup');
    if (setup === 'success') toast.success('Payment method saved.');
    if (setup === 'cancelled') toast.message('Nothing was saved.');
  }, []);

  const go = (url: string) => window.location.assign(url);
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.billing.status.queryKey() });
  const subscribe = useMutation(
    trpc.billing.subscribe.mutationOptions({
      onSuccess: async (res) => {
        if ('url' in res) return go(res.url);
        toast.success('Plan changed');
        await refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const trueUp = useMutation(
    trpc.billing.setTrueUp.mutationOptions({
      onSuccess: refresh,
      onError: (e) => toast.error(e.message),
    }),
  );
  const [invoiceNote, setInvoiceNote] = useState('');
  const requestInvoice = useMutation(
    trpc.billing.requestInvoice.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Request sent. Kestrel staff will be in touch.');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const subscribeByInvoice = useMutation(
    trpc.billing.subscribeByInvoice.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Done. Your invoice will be emailed to you shortly.');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const portal = useMutation(
    trpc.billing.portal.mutationOptions({
      onSuccess: (res) => go(res.url),
      onError: (e) => toast.error(e.message),
    }),
  );

  if (!isOwner) return null;
  if (billing.isPending)
    return (
      <PageContainer className="max-w-3xl">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-40 w-full" />
      </PageContainer>
    );
  const b = billing.data;
  if (!b) return null;
  const e = b.entitlements;
  const paid = e.plan === 'basic' || e.plan === 'pro';
  // A provider pays: there is nothing to buy or manage here (BD-11).
  const delegated = b.delegation.status === 'active';
  const live = ['active', 'trialing', 'past_due'].includes(b.subscription.status);
  const currentInterval = b.subscription.interval;
  // Asking for invoice billing needs no Stripe; starting the invoiced subscription does.
  const canInvoice = b.available && b.yearlyAvailable;
  // Yearly is only offered when the server has both yearly prices.
  const interval: BillingInterval = !b.yearlyAvailable
    ? 'month'
    : (pickedInterval ?? (paid ? currentInterval : 'month'));

  const unit = (plan: PaidPlan) =>
    prices.data?.find((p) => p.plan === plan && p.interval === interval) ?? null;
  const typed = roomsInput.trim() === '' ? null : Number(roomsInput);
  const estimateRooms = Math.max(
    1,
    Math.floor(typed !== null && Number.isFinite(typed) ? typed : b.rooms),
  );
  const periodWord = interval === 'year' ? 'year' : 'month';
  const anyPrice = !!unit('basic') || !!unit('pro');

  return (
    <PageContainer className="max-w-3xl">
      <PageHeader
        title="Plan and billing"
        description="Charged per monitored room, per month. A room is monitored once it has a networked device with a driver. Recorded assets cost nothing."
      />

      <section className="space-y-2 rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm text-muted-foreground">Current plan</div>
            <div className="text-xl font-semibold">{PLAN_LABEL[e.plan]}</div>
          </div>
          {b.subscription.managed && !delegated && (
            <Button
              variant="outline"
              size="sm"
              disabled={portal.isPending}
              onClick={() => portal.mutate({ orgId })}
            >
              {portal.isPending && <Spinner />}
              Manage payment and invoices
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {e.plan === 'trial' &&
            `Your trial ends in ${plural(e.trialDaysLeft ?? 0, 'day')}. It includes every feature and up to ${e.maxRooms} monitored rooms.`}
          {e.plan === 'trial_expired' &&
            'Your free trial is over (or was already used by you or your company). Existing rooms are still monitored, but there are no alerts, no usage or reports, no new monitored rooms and no Premium features.'}
          {e.plan === 'lapsed' &&
            'Your subscription has ended, so you are on Essentials: monitoring, the asset register and email alerts. Configuration, maintenance, signed register issues and service desk connections are switched off until you choose Premium; nothing is deleted.'}
          {paid &&
            !delegated &&
            `${plural(b.subscription.quantity || b.rooms, 'room')} billed.${
              b.subscription.currentPeriodEnd
                ? ` ${b.subscription.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${formatDate(b.subscription.currentPeriodEnd)}.`
                : ''
            }${b.subscription.status === 'past_due' ? ' A payment failed. Update your card to avoid interruption.' : ''}`}
        </p>
        {e.adjusted && (
          <p className="text-sm">
            Kestrel has adjusted your licence
            {e.adjusted.until ? ` until ${formatDate(e.adjusted.until)}` : ''}. Contact support if
            you have questions.
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {plural(b.rooms, 'monitored room')}
          {e.maxRooms !== null ? ` of ${e.maxRooms} on this plan` : ''}.
        </p>
      </section>

      <WhoPays
        delegation={b.delegation}
        directEnd={
          paid && live && b.delegation.billedBy === 'self' ? b.subscription.currentPeriodEnd : null
        }
      />
      <ProviderBillingInbox />

      {!delegated && (
        <>
          {b.subscription.managed && (
            <section className="flex items-start justify-between gap-4 rounded-lg border p-4">
              <div>
                <div className="text-sm font-medium">True up new rooms</div>
                <p className="text-sm text-muted-foreground">
                  When rooms are added part-way through a billing period, charge for them straight
                  away pro rata to the end of the period. From the next billing date they are billed
                  with the rest of your rooms. Off: the pro rata charge appears on your next
                  invoice.
                </p>
              </div>
              <Switch
                aria-label="True up new rooms"
                checked={b.subscription.trueUp}
                disabled={trueUp.isPending}
                onCheckedChange={(enabled) => trueUp.mutate({ orgId, enabled })}
              />
            </section>
          )}

          <>
            <section className="space-y-3 rounded-lg border p-4">
              <div className="text-sm font-medium">Pay by invoice</div>
              {b.subscription.collectionMethod === 'send_invoice' ? (
                <div className="space-y-1 text-sm text-muted-foreground">
                  <p>
                    You are billed yearly by invoice, emailed to you with {b.invoiceBilling.days}{' '}
                    days to pay. Add a card as a backup and it is charged if an invoice is still
                    unpaid after its due date.
                  </p>
                  {b.subscription.openInvoice && (
                    <p className="text-foreground">
                      An invoice is waiting
                      {b.subscription.openInvoice.dueAt
                        ? `, due ${formatDate(b.subscription.openInvoice.dueAt)}`
                        : ''}
                      .{' '}
                      {b.subscription.openInvoice.url && (
                        <a
                          href={b.subscription.openInvoice.url}
                          target="_blank"
                          rel="noreferrer"
                          className="underline underline-offset-2"
                        >
                          View and pay
                        </a>
                      )}
                    </p>
                  )}
                </div>
              ) : b.invoiceBilling.status === 'approved' ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Approved. Choose a plan to be invoiced yearly. Access starts straight away and
                    you have {b.invoiceBilling.days} days to pay the invoice. Adding a card as a
                    backup is optional.
                  </p>
                  {!canInvoice && (
                    <p className="text-sm text-muted-foreground">
                      Starting an invoiced subscription needs payments and yearly prices to be set
                      up on this Kestrel server.
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {PAID_PLANS.map((plan: PaidPlan) => (
                      <Button
                        key={plan}
                        variant="outline"
                        size="sm"
                        disabled={subscribeByInvoice.isPending || !canInvoice}
                        onClick={() => subscribeByInvoice.mutate({ orgId, plan })}
                      >
                        {subscribeByInvoice.isPending &&
                          subscribeByInvoice.variables?.plan === plan && <Spinner />}
                        Invoice me for {PLAN_FEATURES[plan].label} (yearly)
                      </Button>
                    ))}
                  </div>
                </div>
              ) : b.invoiceBilling.status === 'requested' ? (
                <p className="text-sm text-muted-foreground">
                  Your request to pay by invoice is with Kestrel staff.
                </p>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Prefer an invoice to a card? Yearly plans can be invoiced once Kestrel staff
                    approve it.
                  </p>
                  {b.invoiceBilling.status === 'declined' && b.invoiceBilling.declineReason && (
                    <p className="text-sm">
                      Last request declined: {b.invoiceBilling.declineReason}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Input
                      className="max-w-sm"
                      aria-label="Note for Kestrel staff (optional)"
                      placeholder="Note for Kestrel staff (optional)"
                      maxLength={500}
                      value={invoiceNote}
                      onChange={(ev) => setInvoiceNote(ev.target.value)}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={requestInvoice.isPending}
                      onClick={() => requestInvoice.mutate({ orgId, note: invoiceNote })}
                    >
                      {requestInvoice.isPending && <Spinner />}
                      Request invoice billing
                    </Button>
                  </div>
                </div>
              )}
            </section>
          </>

          {!b.available && (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              Payments aren’t set up on this Kestrel server yet, so plans can’t be changed here. Add
              the Stripe keys and prices to the server settings to switch them on.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <div
              role="group"
              aria-label="Billing interval"
              className="inline-flex rounded-md border p-0.5"
            >
              {(['month', 'year'] as const).map((i) => (
                <button
                  key={i}
                  type="button"
                  aria-pressed={interval === i}
                  disabled={i === 'year' && !b.yearlyAvailable}
                  onClick={() => setPickedInterval(i)}
                  className={cn(
                    'rounded px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-50',
                    interval === i ? 'bg-muted font-medium' : 'text-muted-foreground',
                  )}
                >
                  {i === 'month' ? 'Monthly' : 'Yearly'}
                </button>
              ))}
            </div>
            {!b.yearlyAvailable && (
              <span className="text-sm text-muted-foreground">
                Yearly billing isn’t set up yet.
              </span>
            )}
            {paid && live && interval !== currentInterval && (
              <span className="text-sm text-muted-foreground">
                Changing between monthly and yearly restarts your billing date and is charged now,
                with credit for unused time.
              </span>
            )}
          </div>

          {live && paid ? (
            b.subscription.anchorFirstOfMonth && (
              <p className="text-sm text-muted-foreground">
                Billed on the 1st of each month. The billing date can’t be changed on a running
                subscription.
              </p>
            )
          ) : (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={anchor}
                onChange={(ev) => setAnchor(ev.target.checked)}
              />
              Bill on the 1st of each month (first period charged pro rata)
            </label>
          )}

          <section className="space-y-2 rounded-lg border p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-sm font-medium">What it would cost</div>
                <p className="text-sm text-muted-foreground">
                  {plural(b.rooms, 'monitored room')} today
                  {typed !== null && estimateRooms !== Math.max(1, b.rooms)
                    ? `, shown for ${plural(estimateRooms, 'room')}`
                    : ''}
                  . Only rooms with a monitored device are charged.
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                Try a different number of rooms
                <Input
                  type="number"
                  min={1}
                  max={100000}
                  inputMode="numeric"
                  className="w-24"
                  aria-label="Number of rooms to price"
                  placeholder={String(Math.max(1, b.rooms))}
                  value={roomsInput}
                  onChange={(ev) => setRoomsInput(ev.target.value)}
                />
              </label>
            </div>
            {prices.isPending ? (
              <Skeleton className="h-6 w-2/3" />
            ) : !anyPrice ? (
              <p className="text-sm text-muted-foreground">
                Price on request. Prices aren’t set up on this Kestrel server yet.
              </p>
            ) : (
              <ul className="space-y-1 text-sm">
                {PAID_PLANS.map((plan: PaidPlan) => {
                  const u = unit(plan);
                  return (
                    <li key={plan} className="flex flex-wrap justify-between gap-2">
                      <span>{PLAN_FEATURES[plan].label}</span>
                      <span className="font-medium">
                        {u
                          ? `${formatMoney(u.unitAmount * estimateRooms, u.currency)} per ${periodWord}`
                          : 'Price on request'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <div className="grid gap-4 sm:grid-cols-2">
            {PAID_PLANS.map((plan: PaidPlan) => {
              const p = PLAN_FEATURES[plan];
              const current = e.plan === plan && (!live || currentInterval === interval);
              return (
                <section
                  key={plan}
                  className={cn('flex flex-col rounded-lg border p-4', current && 'border-brand')}
                >
                  <div className="text-lg font-semibold">{p.label}</div>
                  <PlanPriceLine
                    price={unit(plan)}
                    pending={prices.isPending}
                    interval={interval}
                    rooms={estimateRooms}
                  />
                  <p className="mb-3 text-sm text-muted-foreground">{p.summary}</p>
                  <ul className="mb-4 flex-1 space-y-1.5">
                    {p.features.map((f) => (
                      <li key={f} className="flex items-start gap-2 text-sm">
                        <Check className="mt-0.5 size-4 shrink-0 text-success" />
                        {f}
                      </li>
                    ))}
                  </ul>
                  <Button
                    variant={current ? 'outline' : 'default'}
                    disabled={current || !b.available || subscribe.isPending}
                    onClick={() =>
                      subscribe.mutate({
                        orgId,
                        plan,
                        interval,
                        ...(!(live && paid) && anchor ? { anchorFirstOfMonth: true } : {}),
                      })
                    }
                  >
                    {subscribe.isPending && subscribe.variables?.plan === plan && <Spinner />}
                    {current ? 'Your plan' : paid ? `Switch to ${p.label}` : `Choose ${p.label}`}
                  </Button>
                </section>
              );
            })}
          </div>
        </>
      )}
    </PageContainer>
  );
}

function PlanPriceLine({
  price,
  pending,
  interval,
  rooms,
}: {
  price: {
    unitAmount: number;
    currency: string;
    tax: 'inclusive' | 'exclusive' | 'unspecified';
  } | null;
  pending: boolean;
  interval: BillingInterval;
  rooms: number;
}) {
  if (pending) return <Skeleton className="my-2 h-6 w-32" />;
  if (!price) return <p className="my-1 text-sm text-muted-foreground">Price on request</p>;
  return (
    <div className="my-1">
      <div>
        <span className="text-2xl font-semibold">
          {formatMoney(price.unitAmount, price.currency)}
        </span>{' '}
        <span className="text-sm text-muted-foreground">
          per room per {interval === 'year' ? 'year' : 'month'}
        </span>
      </div>
      <div className="text-xs text-muted-foreground">
        {interval === 'year'
          ? `About ${formatMoney(perMonthFromYear(price.unitAmount), price.currency)} per room per month. `
          : ''}
        {plural(rooms, 'room')}: {formatMoney(price.unitAmount * rooms, price.currency)} per{' '}
        {interval === 'year' ? 'year' : 'month'}, {taxNote(price.tax)}.
      </div>
    </div>
  );
}
