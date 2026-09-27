// Plans and what each one includes. Pure, so the portal, the API and the tests all agree.
export const PAID_PLANS = ['basic', 'pro'] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];
export type StoredPlan = 'trial' | PaidPlan;

/** How long a new organisation's trial lasts, and how many rooms it can have. */
export const TRIAL_DAYS = 30;
export const TRIAL_MAX_ROOMS = 5;
/** Rooms a paid organisation may have for now. Staff can raise or lower it per organisation. */
export const PAID_MAX_ROOMS = 500;
/** The alert channels Basic keeps. Pro (and a running trial) has all of them. */
export const BASIC_ALERT_CHANNELS = ['email'] as const;

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
  /** Deploying and controlling rooms: the panel, the portal's controls, room design. Pro and a running trial. */
  control: boolean;
  /** Watching devices and rooms. Every plan has it, so a room is never left unwatched by billing. */
  monitoring: boolean;
  /** Sending alerts at all. Off once a trial has ended. */
  alerts: boolean;
  /** Teams, webhook and ITSM alerts as well as email. */
  allAlertChannels: boolean;
  /** Usage and reports. */
  analytics: boolean;
  marketplaceBuy: boolean;
  marketplacePublish: boolean;
  driverCreate: boolean;
  /** Most rooms the organisation may have, or null for no limit. */
  maxRooms: number | null;
  trialEndsAt: Date | null;
  trialDaysLeft: number | null;
  /** Set when Kestrel staff have adjusted this organisation's licence. `until` is null for no end date. */
  adjusted?: { until: Date | null };
}

/** Nothing but watching what is already there: an ended trial. */
const MONITOR_ONLY = {
  control: false,
  monitoring: true,
  alerts: false,
  allAlertChannels: false,
  analytics: false,
  marketplaceBuy: false,
  marketplacePublish: false,
  driverCreate: false,
  maxRooms: 0,
} as const;

/** Basic: monitoring, email alerts and analytics. No control, no marketplace, no custom drivers. */
const BASIC = {
  ...MONITOR_ONLY,
  alerts: true,
  analytics: true,
  maxRooms: PAID_MAX_ROOMS,
} as const;

/**
 * What an organisation may do right now. A trial has control and monitoring for 30 days, then drops
 * to monitoring only: existing rooms are still watched, but there are no alerts, no analytics and
 * no new rooms. Basic is monitoring only; Pro adds control, every alert channel, the marketplace and
 * custom drivers. A paid plan that stops paying falls back to Basic.
 */
export function entitlementsFor(state: BillingState, now = new Date()): Entitlements {
  const trialDaysLeft =
    state.trialEndsAt && state.trialEndsAt.getTime() > now.getTime()
      ? Math.ceil((state.trialEndsAt.getTime() - now.getTime()) / 86_400_000)
      : 0;
  const base = { trialEndsAt: state.trialEndsAt, trialDaysLeft };

  if (state.plan === 'trial')
    return trialDaysLeft > 0
      ? {
          plan: 'trial',
          ...BASIC,
          control: true,
          allAlertChannels: true,
          maxRooms: TRIAL_MAX_ROOMS,
          ...base,
        }
      : { plan: 'trial_expired', ...MONITOR_ONLY, ...base };

  if (!PAYING_STATUSES.has(state.status)) return { plan: 'lapsed', ...BASIC, ...base };

  return state.plan === 'basic'
    ? { plan: 'basic', ...BASIC, ...base }
    : {
        plan: 'pro',
        ...BASIC,
        control: true,
        allAlertChannels: true,
        marketplaceBuy: true,
        marketplacePublish: true,
        driverCreate: true,
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
    summary: 'Watch your rooms and devices.',
    features: [
      'Live monitoring of every device and room',
      'Incidents and email alerts',
      'Usage and reports',
      'Remote diagnostics for support',
    ],
  },
  pro: {
    label: 'Pro',
    summary: 'Everything in Basic, plus control.',
    features: [
      'Everything in Basic',
      'Deploy and control every room',
      'Teams, webhook and service desk alerts',
      'Marketplace templates',
      'Create your own drivers',
    ],
  },
};

export type Feature =
  | 'control'
  | 'monitoring'
  | 'alerts'
  | 'allAlertChannels'
  | 'analytics'
  | 'marketplaceBuy'
  | 'marketplacePublish'
  | 'driverCreate';
export const FEATURE_LABEL: Record<Feature, string> = {
  control: 'Deploying and controlling rooms',
  monitoring: 'Monitoring',
  alerts: 'Alerts',
  allAlertChannels: 'Teams, webhook and service desk alerts',
  analytics: 'Usage and reports',
  marketplaceBuy: 'Marketplace templates',
  marketplacePublish: 'Publishing to the marketplace',
  driverCreate: 'Creating drivers',
};
/** The lowest plan that includes a feature, for "upgrade to ..." messages. */
export const FEATURE_PLAN: Record<Feature, PaidPlan> = {
  control: 'pro',
  monitoring: 'basic',
  alerts: 'basic',
  allAlertChannels: 'pro',
  analytics: 'basic',
  marketplaceBuy: 'pro',
  marketplacePublish: 'pro',
  driverCreate: 'pro',
};

/** Whether an alert channel type may be used, given what the plan allows. */
export function alertChannelAllowed(
  e: Pick<Entitlements, 'alerts' | 'allAlertChannels'>,
  type: string,
) {
  return (
    e.alerts && (e.allAlertChannels || (BASIC_ALERT_CHANNELS as readonly string[]).includes(type))
  );
}

/**
 * A staff adjustment to what an organisation may do (see OrgLicenseOverride). Every field is
 * optional: only what is set changes anything.
 */
export interface LicenseOverride {
  /** Behave as if the organisation were on this plan. */
  plan?: string | null;
  /** A new trial end date. With plan "trial" it sets the date; on its own it extends the organisation's own trial. */
  trialEndsAt?: Date | null;
  maxRooms?: number | null;
  unlimitedRooms?: boolean;
  /** Force monitoring on or off. */
  monitoring?: boolean | null;
  /** Force control on or off. */
  control?: boolean | null;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}

/** Whether an override still counts: not revoked and not past its end date. */
export function overrideActive(o: LicenseOverride | null | undefined, now = new Date()): boolean {
  return !!o && !o.revokedAt && (!o.expiresAt || o.expiresAt.getTime() > now.getTime());
}

/**
 * What an organisation may do, given what it pays for and any staff adjustment. Without an active
 * override this is exactly `entitlementsFor`. An override can switch the plan, move the trial end,
 * change the room limit or force monitoring, and lasts until it is revoked or expires.
 */
export function entitlementsWithOverride(
  state: BillingState,
  override: LicenseOverride | null | undefined,
  now = new Date(),
): Entitlements {
  if (!override || !overrideActive(override, now)) return entitlementsFor(state, now);

  let effective: BillingState = state;
  if (override.plan === 'basic' || override.plan === 'pro')
    effective = { plan: override.plan, status: 'active', trialEndsAt: state.trialEndsAt };
  else if (override.plan === 'trial')
    effective = {
      plan: 'trial',
      status: 'none',
      trialEndsAt: override.trialEndsAt ?? state.trialEndsAt,
    };
  else if (override.trialEndsAt && state.plan === 'trial')
    effective = {
      ...state,
      trialEndsAt:
        state.trialEndsAt && state.trialEndsAt.getTime() > override.trialEndsAt.getTime()
          ? state.trialEndsAt
          : override.trialEndsAt,
    };

  const e: Entitlements = {
    ...entitlementsFor(effective, now),
    adjusted: { until: override.expiresAt ?? null },
  };
  if (override.monitoring !== null && override.monitoring !== undefined)
    e.monitoring = override.monitoring;
  if (override.control !== null && override.control !== undefined) e.control = override.control;
  if (override.unlimitedRooms) e.maxRooms = null;
  else if (override.maxRooms !== null && override.maxRooms !== undefined)
    e.maxRooms = override.maxRooms;
  return e;
}
