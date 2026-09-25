import { describe, expect, it } from 'vitest';
import {
  TRIAL_MAX_ROOMS,
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
  it('gives a trial everything except the marketplace, limited to five rooms', () => {
    const e = entitlementsFor(state(), NOW);
    expect(e).toMatchObject({
      plan: 'trial',
      control: true,
      monitoring: true,
      maxRooms: TRIAL_MAX_ROOMS,
      trialDaysLeft: 10,
    });
    expect(e.marketplaceBuy || e.marketplacePublish || e.driverCreate).toBe(false);
  });

  it('drops to control only when the trial ends, without touching control', () => {
    const e = entitlementsFor(state({ trialEndsAt: new Date(NOW.getTime() - 1) }), NOW);
    expect(e).toMatchObject({
      plan: 'trial_expired',
      control: true,
      monitoring: false,
      trialDaysLeft: 0,
      maxRooms: TRIAL_MAX_ROOMS,
    });
  });

  it('counts a partly used day as a day left', () => {
    expect(
      entitlementsFor(state({ trialEndsAt: new Date(NOW.getTime() + 3 * day + 1000) }), NOW)
        .trialDaysLeft,
    ).toBe(4);
  });

  it('Basic controls rooms and buys templates, with no monitoring and no room limit', () => {
    const e = entitlementsFor(state({ plan: 'basic', status: 'active' }), NOW);
    expect(e).toMatchObject({
      plan: 'basic',
      monitoring: false,
      marketplaceBuy: true,
      marketplacePublish: false,
      driverCreate: false,
      maxRooms: null,
    });
  });

  it('Pro has everything', () => {
    const e = entitlementsFor(state({ plan: 'pro', status: 'active' }), NOW);
    expect(e).toMatchObject({
      plan: 'pro',
      monitoring: true,
      marketplaceBuy: true,
      marketplacePublish: true,
      driverCreate: true,
      maxRooms: null,
    });
  });

  it('keeps a paid plan through a payment retry, and while a Stripe trial runs', () => {
    expect(entitlementsFor(state({ plan: 'pro', status: 'past_due' }), NOW).plan).toBe('pro');
    expect(entitlementsFor(state({ plan: 'pro', status: 'trialing' }), NOW).plan).toBe('pro');
  });

  it('falls back to control only when a subscription ends or is unpaid, whatever the old trial date says', () => {
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
        monitoring: false,
        marketplaceBuy: false,
        control: true,
      });
    }
  });

  it('never turns control off', () => {
    for (const plan of ['trial', 'basic', 'pro'] as const)
      for (const status of ['none', 'active', 'canceled'])
        expect(entitlementsFor(state({ plan, status, trialEndsAt: null }), NOW).control).toBe(true);
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

  it('extends an ended trial, so monitoring comes back', () => {
    const e = entitlementsWithOverride(expiredTrial, { trialEndsAt: days(14) }, NOW);
    expect(e).toMatchObject({ plan: 'trial', monitoring: true, trialDaysLeft: 14 });
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
      maxRooms: null,
    });
  });

  it('can force monitoring on for a plan that lacks it, or off for one that has it', () => {
    expect(entitlementsWithOverride(paid, { monitoring: true }, NOW).monitoring).toBe(true);
    expect(
      entitlementsWithOverride({ ...paid, plan: 'pro' }, { monitoring: false }, NOW).monitoring,
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
