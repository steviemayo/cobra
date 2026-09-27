'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { FEATURE_LABEL, FEATURE_PLAN, PLAN_FEATURES, type Feature } from '@kestrel/model';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/trpc/client';
import { EmptyState } from './empty-state';
import { PageContainer } from './page-header';

export function useBilling() {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  return useQuery({ ...trpc.billing.status.queryOptions({ orgId }), staleTime: 60_000 });
}

/** Shows its children only if the organisation's plan includes the feature; otherwise says what to do. */
export function RequireFeature({
  feature,
  children,
}: {
  feature: Feature;
  children: React.ReactNode;
}) {
  const { orgId, isOwner } = useOrg();
  const billing = useBilling();
  if (billing.isPending)
    return (
      <PageContainer>
        <Skeleton className="h-24 w-full" />
      </PageContainer>
    );
  if (billing.data && !billing.data.entitlements[feature]) {
    const e = billing.data.entitlements;
    const plan = PLAN_FEATURES[FEATURE_PLAN[feature]].label;
    const ended = e.plan === 'trial_expired' || e.plan === 'lapsed';
    return (
      <PageContainer>
        <EmptyState
          icon={Lock}
          title={`${FEATURE_LABEL[feature]} isn’t part of your plan`}
          description={
            <>
              {ended
                ? e.plan === 'lapsed'
                  ? 'Your subscription has ended, so this has been switched off. Your rooms are still monitored.'
                  : 'Your free trial is over, so this is switched off. Your rooms are still monitored.'
                : `It’s included in ${plan}.`}{' '}
              {isOwner ? `Choose ${plan} to switch it back on.` : 'Ask an owner to upgrade.'}
            </>
          }
          action={
            isOwner ? (
              <Link href={orgPath(orgId, '/settings/billing')} className={buttonVariants()}>
                See plans
              </Link>
            ) : undefined
          }
        />
      </PageContainer>
    );
  }
  return <>{children}</>;
}

/** A thin strip above every page while a trial is about to end, or after it has. */
export function TrialBanner() {
  const { orgId, isOwner } = useOrg();
  const billing = useBilling();
  const e = billing.data?.entitlements;
  if (!e) return null;
  const ending = e.plan === 'trial' && e.trialDaysLeft !== null && e.trialDaysLeft <= 7;
  const ended = e.plan === 'trial_expired' || e.plan === 'lapsed';
  if (!ending && !ended) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-warning/10 px-4 py-2 text-sm">
      <span>
        {ending
          ? `Your trial ends in ${e.trialDaysLeft} ${e.trialDaysLeft === 1 ? 'day' : 'days'}. After that, control, alerts and reports switch off; your rooms are still monitored.`
          : e.plan === 'lapsed'
            ? 'Your subscription has ended. You are on Basic: control is off; your rooms are still monitored.'
            : 'Your trial has ended. Control, alerts and reports are off; your rooms are still monitored.'}
      </span>
      {isOwner && (
        <Link
          href={orgPath(orgId, '/settings/billing')}
          className="font-medium underline-offset-4 hover:underline"
        >
          See plans
        </Link>
      )}
    </div>
  );
}
