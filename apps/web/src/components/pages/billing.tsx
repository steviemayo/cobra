'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { toast } from 'sonner';
import { PAID_PLANS, PLAN_FEATURES, PLAN_LABEL, type PaidPlan } from '@kestrel/model';
import { useBilling } from '@/components/common/plan-gate';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { formatDate, plural } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';

export function BillingView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const { orgId, isOwner } = useOrg();
  const billing = useBilling();

  useEffect(() => {
    if (!isOwner) router.replace(orgPath(orgId, '/settings/activity'));
  }, [isOwner, orgId, router]);

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('checkout');
    if (result === 'success') toast.success('Thanks! Your plan updates in a moment.');
    if (result === 'cancelled') toast.message('Checkout cancelled. You haven’t been charged.');
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

  return (
    <PageContainer className="max-w-3xl">
      <PageHeader title="Plan and billing" description="Charged per room, per month." />

      <section className="space-y-2 rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm text-muted-foreground">Current plan</div>
            <div className="text-xl font-semibold">{PLAN_LABEL[e.plan]}</div>
          </div>
          {b.subscription.managed && (
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
            `Your trial ends in ${plural(e.trialDaysLeft ?? 0, 'day')}. It includes monitoring and up to ${e.maxRooms} rooms.`}
          {e.plan === 'trial_expired' &&
            'Your trial has ended. Rooms keep running and can be deployed, but monitoring is off.'}
          {e.plan === 'lapsed' &&
            'Your subscription has ended. Rooms keep running and can be deployed, but monitoring is off.'}
          {paid &&
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
          {plural(b.rooms, 'room')} in use
          {e.maxRooms !== null ? ` of ${e.maxRooms} on this plan` : ''}.
        </p>
      </section>

      {!b.available && (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          Payments aren’t set up on this Kestrel server yet, so plans can’t be changed here. Add the
          Stripe keys and prices to the server settings to switch them on.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {PAID_PLANS.map((plan: PaidPlan) => {
          const p = PLAN_FEATURES[plan];
          const current = e.plan === plan;
          return (
            <section
              key={plan}
              className={cn('flex flex-col rounded-lg border p-4', current && 'border-brand')}
            >
              <div className="text-lg font-semibold">{p.label}</div>
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
                onClick={() => subscribe.mutate({ orgId, plan })}
              >
                {subscribe.isPending && subscribe.variables?.plan === plan && <Spinner />}
                {current ? 'Your plan' : paid ? `Switch to ${p.label}` : `Choose ${p.label}`}
              </Button>
            </section>
          );
        })}
      </div>
    </PageContainer>
  );
}
