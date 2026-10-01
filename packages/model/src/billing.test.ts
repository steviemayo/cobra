import { describe, expect, it } from 'vitest';
import {
  PAID_MAX_ROOMS,
  PLAN_FEATURES,
  PLAN_LABEL,
  TRIAL_MAX_ROOMS,
  alertChannelAllowed,
  entitlementsFor,
  entitlementsWithOverride,
  overrideActive,
  type BillingState,
} from './billing';

const NOW = new Date('2026-09-24T00:00:00Z');
const day = 86_400_000;
const state = (over: Partial<BillingState> = {}): BillingState => ({
  plan: 'trial',
  status: 'none',
  trialEndsAt: new Date(NOW.getTime() + 10 * day),
  ...over,
});

describe('entitlements', () => {
  it('gives a trial every feature and alert channel except the marketplace, limited to five rooms', () => {
    const e = entitlementsFor(state(), NOW);
    expect(e).toMatchObject({
      plan: 'trial',
      control: true,
      monitoring: true,
      alerts: true,
      allAlertChannels: true,
      analytics: true,
      maxRooms: TRIAL_MAX_ROOMS,
      trialDaysLeft: 10,
    });
    expect(e.marketplaceBuy || e.marketplacePublish).toBe(false);
    expect(e).toMatchObject({
      configuration: true,
      registerIssues: true,
      maintenance: true,
      serviceDesk: true,
      usageDefinitions: true,
      driverCreate: true,
    });
  });

  it('drops to monitoring only when the trial ends: no control, alerts, analytics or new rooms', () => {
    const e = entitlementsFor(state({ trialEndsAt: new Date(NOW.getTime() - 1) }), NOW);
    expect(e).toMatchObject({
      plan: 'trial_expired',
      control: false,
      monitoring: true,
      alerts: false,
      allAlertChannels: false,
      analytics: false,
      trialDaysLeft: 0,
      maxRooms: 0,
    });
  });

  it('counts a partly used day as a day left', () => {
    expect(
      entitlementsFor(state({ trialEndsAt: new Date(NOW.getTime() + 3 * day + 1000) }), NOW)
        .trialDaysLeft,
    ).toBe(4);
  });

  it('Basic is monitoring only: email alerts and analytics, no control, marketplace or custom drivers', () => {
    const e = entitlementsFor(state({ plan: 'basic', status: 'active' }), NOW);
    expect(e).toMatchObject({
      plan: 'basic',
      control: false,
      monitoring: true,
      alerts: true,
      allAlertChannels: false,
      analytics: true,
      marketplaceBuy: false,
      marketplacePublish: false,
      driverCreate: false,
      maxRooms: PAID_MAX_ROOMS,
    });
  });

  it('Pro has everything', () => {
    const e = entitlementsFor(state({ plan: 'pro', status: 'active' }), NOW);
    expect(e).toMatchObject({
      plan: 'pro',
      control: true,
      monitoring: true,
      alerts: true,
      allAlertChannels: true,
      analytics: true,
      marketplaceBuy: true,
      marketplacePublish: true,
      driverCreate: true,
      maxRooms: PAID_MAX_ROOMS,
    });
  });

  it('keeps a paid plan through a payment retry, and while a Stripe trial runs', () => {
    expect(entitlementsFor(state({ plan: 'pro', status: 'past_due' }), NOW).plan).toBe('pro');
    expect(entitlementsFor(state({ plan: 'pro', status: 'trialing' }), NOW).plan).toBe('pro');
  });

  it('falls back to Basic when a subscription ends or is unpaid, whatever the old trial date says', () => {
    for (const status of [
      'canceled',
      'unpaid',
      'incomplete',
      'incomplete_expired',
      'paused',
      'none',
    ]) {
      const e = entitlementsFor(state({ plan: 'pro', status }), NOW);
      expect(e, status).toMatchObject({
        plan: 'lapsed',
        control: false,
        monitoring: true,
        alerts: true,
        allAlertChannels: false,
        marketplaceBuy: false,
        maxRooms: PAID_MAX_ROOMS,
      });
    }
  });

  it('never turns monitoring off, whatever the plan', () => {
    for (const plan of ['trial', 'basic', 'pro'] as const)
      for (const status of ['none', 'active', 'canceled'])
        expect(entitlementsFor(state({ plan, status, trialEndsAt: null }), NOW).monitoring).toBe(
          true,
        );
  });

  it('allows email alerts on Basic, and every channel on Pro and a running trial', () => {
    const basic = entitlementsFor(state({ plan: 'basic', status: 'active' }), NOW);
    const pro = entitlementsFor(state({ plan: 'pro', status: 'active' }), NOW);
    const ended = entitlementsFor(state({ trialEndsAt: new Date(NOW.getTime() - 1) }), NOW);
    expect(alertChannelAllowed(basic, 'email')).toBe(true);
    for (const t of ['sms', 'teams', 'webhook', 'itsm']) {
      expect(alertChannelAllowed(basic, t), t).toBe(false);
      expect(alertChannelAllowed(pro, t), t).toBe(true);
      expect(alertChannelAllowed(ended, t), t).toBe(false);
    }
    expect(alertChannelAllowed(ended, 'email')).toBe(false);
  });
});

describe('Essentials and Pro (v2)', () => {
  const paying = (plan: 'basic' | 'pro') =>
    entitlementsFor({ plan, status: 'active', trialEndsAt: null }, NOW);

  it('Essentials has monitoring, the register, alerts by email and usage, but none of the Pro features', () => {
    const e = paying('basic');
    expect(e).toMatchObject({
      monitoring: true,
      alerts: true,
      analytics: true,
      allAlertChannels: false,
    });
    expect(
      e.configuration ||
        e.registerIssues ||
        e.maintenance ||
        e.serviceDesk ||
        e.usageDefinitions ||
        e.driverCreate,
    ).toBe(false);
  });

  it('Pro adds configuration, signed register issues, maintenance, service desks, own definitions and every alert channel', () => {
    expect(paying('pro')).toMatchObject({
      configuration: true,
      registerIssues: true,
      maintenance: true,
      serviceDesk: true,
      usageDefinitions: true,
      allAlertChannels: true,
    });
  });

  it('an ended trial and a lapsed subscription switch the Pro features off but keep monitoring', () => {
    const ended = entitlementsFor(
      { plan: 'trial', status: 'none', trialEndsAt: new Date(NOW.getTime() - 1000) },
      NOW,
    );
    expect(ended).toMatchObject({
      monitoring: true,
      configuration: false,
      maintenance: false,
      registerIssues: false,
    });
    const lapsed = entitlementsFor({ plan: 'pro', status: 'canceled', trialEndsAt: null }, NOW);
    expect(lapsed).toMatchObject({ monitoring: true, configuration: false, serviceDesk: false });
  });

  it('calls the lower plan Essentials', () => {
    expect(PLAN_LABEL.basic).toBe('Essentials');
    expect(PLAN_FEATURES.basic.label).toBe('Essentials');
  });
});

describe('a staff adjustment', () => {
  const NOW = new Date('2026-09-25T00:00:00Z');
  const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
  const expiredTrial = { plan: 'trial' as const, status: 'none', trialEndsAt: days(-3) };
  const paid = { plan: 'basic' as const, status: 'active', trialEndsAt: days(-100) };

  it('changes nothing when there is none, or when it has expired or been revoked', () => {
    const plain = entitlementsFor(expiredTrial, NOW);
    expect(entitlementsWithOverride(expiredTrial, null, NOW)).toEqual(plain);
    expect(
      entitlementsWithOverride(expiredTrial, { plan: 'pro', expiresAt: days(-1) }, NOW),
    ).toEqual(plain);
    expect(
      entitlementsWithOverride(expiredTrial, { plan: 'pro', revokedAt: days(-1) }, NOW),
    ).toEqual(plain);
  });

  it('extends an ended trial, so control and alerts come back', () => {
    const e = entitlementsWithOverride(expiredTrial, { trialEndsAt: days(14) }, NOW);
    expect(e).toMatchObject({ plan: 'trial', control: true, alerts: true, trialDaysLeft: 14 });
    expect(e.adjusted).toEqual({ until: null });
  });

  it('never shortens a trial that already runs longer', () => {
    const long = { plan: 'trial' as const, status: 'none', trialEndsAt: days(20) };
    expect(entitlementsWithOverride(long, { trialEndsAt: days(5) }, NOW).trialDaysLeft).toBe(20);
  });

  it('ignores a trial extension for an organisation that pays', () => {
    expect(entitlementsWithOverride(paid, { trialEndsAt: days(14) }, NOW).plan).toBe('basic');
  });

  it('comps a plan without a subscription', () => {
    const e = entitlementsWithOverride(expiredTrial, { plan: 'pro' }, NOW);
    expect(e).toMatchObject({
      plan: 'pro',
      monitoring: true,
      marketplacePublish: true,
      driverCreate: true,
      maxRooms: PAID_MAX_ROOMS,
    });
  });

  it('can force monitoring off for a plan that has it, and control on or off', () => {
    expect(
      entitlementsWithOverride({ ...paid, plan: 'pro' }, { monitoring: false }, NOW).monitoring,
    ).toBe(false);
    expect(entitlementsWithOverride(paid, { control: true }, NOW).control).toBe(true);
    expect(
      entitlementsWithOverride({ ...paid, plan: 'pro' }, { control: false }, NOW).control,
    ).toBe(false);
  });

  it('sets or lifts the room limit', () => {
    expect(entitlementsWithOverride(expiredTrial, { maxRooms: 12 }, NOW).maxRooms).toBe(12);
    expect(
      entitlementsWithOverride(expiredTrial, { unlimitedRooms: true }, NOW).maxRooms,
    ).toBeNull();
  });

  it('says when it lasts until, and stops applying after that', () => {
    const o = { plan: 'pro' as const, expiresAt: days(7) };
    expect(entitlementsWithOverride(expiredTrial, o, NOW).adjusted).toEqual({ until: days(7) });
    const later = new Date(NOW.getTime() + 8 * 86_400_000);
    expect(entitlementsWithOverride(expiredTrial, o, later).plan).toBe('trial_expired');
    expect(entitlementsWithOverride(expiredTrial, o, later).adjusted).toBeUndefined();
  });

  it('overrideActive reflects revoked and expired', () => {
    expect(overrideActive(null, NOW)).toBe(false);
    expect(overrideActive({}, NOW)).toBe(true);
    expect(overrideActive({ expiresAt: days(1) }, NOW)).toBe(true);
    expect(overrideActive({ expiresAt: days(-1) }, NOW)).toBe(false);
    expect(overrideActive({ revokedAt: days(-1) }, NOW)).toBe(false);
  });
});
