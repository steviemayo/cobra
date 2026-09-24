import { describe, expect, it } from 'vitest';
import { TRIAL_MAX_ROOMS, entitlementsFor, type BillingState } from './billing';

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
