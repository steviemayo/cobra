// Plans and what each one includes. Pure, so the portal, the API and the tests all agree.
export const PAID_PLANS = ['basic', 'pro'] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];
export type StoredPlan = 'trial' | PaidPlan;

/** How long a new organisation's trial lasts, and how many rooms it can have. */
export const TRIAL_DAYS = 30;
export const TRIAL_MAX_ROOMS = 5;

/** Stripe statuses under which a paid plan keeps working. past_due gets a grace period. */
const PAYING_STATUSES = new Set(['active', 'trialing', 'past_due']);

export interface BillingState {
  plan: StoredPlan;
  /** The Stripe subscription status, or "none". */
  status: string;
  trialEndsAt: Date | null;
}

export type EffectivePlan = 'trial' | 'trial_expired' | 'lapsed' | 'basic' | 'pro';

export interface Entitlements {
  plan: EffectivePlan;
  /** Running rooms and using the panel. Never switched off by billing. */
  control: true;
  monitoring: boolean;
  marketplaceBuy: boolean;
  marketplacePublish: boolean;
  driverCreate: boolean;
  /** Most rooms the organisation may have, or null for no limit. */
  maxRooms: number | null;
  trialEndsAt: Date | null;
  trialDaysLeft: number | null;
}

const CONTROL_ONLY = {
  control: true,
  monitoring: false,
  marketplaceBuy: false,
  marketplacePublish: false,
  driverCreate: false,
  maxRooms: TRIAL_MAX_ROOMS,
} as const;

/**
 * What an organisation may do right now. A trial has everything for 30 days, then drops to control
 * only: rooms keep running and can be deployed, but monitoring and the marketplace switch off.
 * A paid plan that stops paying falls back the same way.
 */
export function entitlementsFor(state: BillingState, now = new Date()): Entitlements {
  const trialDaysLeft =
    state.trialEndsAt && state.trialEndsAt.getTime() > now.getTime()
      ? Math.ceil((state.trialEndsAt.getTime() - now.getTime()) / 86_400_000)
      : 0;
  const base = { trialEndsAt: state.trialEndsAt, trialDaysLeft };

  if (state.plan === 'trial')
    return trialDaysLeft > 0
      ? { plan: 'trial', ...CONTROL_ONLY, monitoring: true, ...base }
      : { plan: 'trial_expired', ...CONTROL_ONLY, ...base };

  if (!PAYING_STATUSES.has(state.status)) return { plan: 'lapsed', ...CONTROL_ONLY, ...base };

  return state.plan === 'basic'
    ? { plan: 'basic', ...CONTROL_ONLY, marketplaceBuy: true, maxRooms: null, ...base }
    : {
        plan: 'pro',
        ...CONTROL_ONLY,
        monitoring: true,
        marketplaceBuy: true,
        marketplacePublish: true,
        driverCreate: true,
        maxRooms: null,
        ...base,
      };
}

export const PLAN_LABEL: Record<EffectivePlan, string> = {
  trial: 'Trial',
  trial_expired: 'Trial ended',
  lapsed: 'Subscription ended',
  basic: 'Basic',
  pro: 'Pro',
};

export const PLAN_FEATURES: Record<
  PaidPlan,
  { label: string; summary: string; features: string[] }
> = {
  basic: {
    label: 'Basic',
    summary: 'Control your rooms and buy templates.',
    features: ['Unlimited rooms', 'Deploy and control every room', 'Buy marketplace templates'],
  },
  pro: {
    label: 'Pro',
    summary: 'Everything in Basic, plus live monitoring.',
    features: [
      'Everything in Basic',
      'Live monitoring, incidents and alerts',
      'Remote diagnostics for support',
      'Publish to the marketplace',
      'Create your own drivers',
    ],
  },
};

export type Feature = 'monitoring' | 'marketplaceBuy' | 'marketplacePublish' | 'driverCreate';
export const FEATURE_LABEL: Record<Feature, string> = {
  monitoring: 'Monitoring',
  marketplaceBuy: 'Buying marketplace templates',
  marketplacePublish: 'Publishing to the marketplace',
  driverCreate: 'Creating drivers',
};
/** The lowest plan that includes a feature, for "upgrade to ..." messages. */
export const FEATURE_PLAN: Record<Feature, PaidPlan> = {
  monitoring: 'pro',
  marketplaceBuy: 'basic',
  marketplacePublish: 'pro',
  driverCreate: 'pro',
};
