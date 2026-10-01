import { describe, expect, it, vi } from 'vitest';
import {
  applyStripeSubscription,
  assertAnchorChangeAllowed,
  checkoutSubscriptionData,
  planAndIntervalForPrice,
  priceIdFor,
  priceMapFromEnv,
  switchParams,
  yearlyAvailable,
  type BillingDb,
  type StripeSubscriptionLike,
} from './billing';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-24T00:00:00Z');
const prices = { basic: 'price_basic', pro: 'price_pro' };
const yearlyPrices = {
  ...prices,
  basicYearly: 'price_basic_y',
  proYearly: 'price_pro_y',
};

function world() {
  const orgBilling = table([]);
  const org = table([{ id: ORG, createdAt: new Date('2026-09-20T00:00:00Z') }]);
  return {
    db: {
      orgBilling,
      stripeEvent: table([]),
      room: table([]),
      org,
    } as unknown as BillingDb,
    orgBilling,
  };
}

const sub = (priceId: string): StripeSubscriptionLike => ({
  id: 'sub_1',
  customer: 'cus_1',
  status: 'active',
  metadata: { orgId: ORG },
  items: {
    data: [{ id: 'si_1', quantity: 2, current_period_end: 1_790_000_000, price: { id: priceId } }],
  },
});

describe('prices and intervals', () => {
  it('reads the price ids from the environment, empty meaning unset', () => {
    expect(
      priceMapFromEnv({
        STRIPE_PRICE_BASIC: 'b',
        STRIPE_PRICE_PRO: 'p',
        STRIPE_PRICE_BASIC_YEARLY: 'by',
        STRIPE_PRICE_PRO_YEARLY: '',
      }),
    ).toEqual({ basic: 'b', pro: 'p', basicYearly: 'by', proYearly: undefined });
  });

  it('works out the plan and interval of a price', () => {
    const f = (id: string | undefined) => planAndIntervalForPrice(yearlyPrices, id);
    expect(f('price_basic')).toEqual({ plan: 'basic', interval: 'month' });
    expect(f('price_pro')).toEqual({ plan: 'pro', interval: 'month' });
    expect(f('price_basic_y')).toEqual({ plan: 'basic', interval: 'year' });
    expect(f('price_pro_y')).toEqual({ plan: 'pro', interval: 'year' });
    expect(f('price_other')).toBeNull();
    expect(f(undefined)).toBeNull();
    expect(f('')).toBeNull();
    expect(planAndIntervalForPrice({}, '')).toBeNull();
  });

  it('picks the price for a plan and interval, and says when yearly is available', () => {
    expect(priceIdFor(yearlyPrices, 'basic', 'month')).toBe('price_basic');
    expect(priceIdFor(yearlyPrices, 'pro', 'year')).toBe('price_pro_y');
    expect(priceIdFor(prices, 'pro', 'year')).toBeUndefined();
    expect(yearlyAvailable(yearlyPrices)).toBe(true);
    expect(yearlyAvailable(prices)).toBe(false);
    expect(yearlyAvailable({ ...prices, basicYearly: 'x' })).toBe(false);
  });

  it('records the interval from the subscription, and leaves it alone for an unknown price', async () => {
    const w = world();
    await applyStripeSubscription(w.db, sub('price_pro_y'), yearlyPrices, NOW);
    expect(w.orgBilling.rows[0]).toMatchObject({ plan: 'pro', billingInterval: 'year' });
    await applyStripeSubscription(w.db, sub('price_pro'), yearlyPrices, NOW);
    expect(w.orgBilling.rows[0]).toMatchObject({ plan: 'pro', billingInterval: 'month' });
    await applyStripeSubscription(w.db, sub('price_basic_y'), yearlyPrices, NOW);
    expect(w.orgBilling.rows[0]).toMatchObject({ plan: 'basic', billingInterval: 'year' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await applyStripeSubscription(w.db, sub('price_unknown'), yearlyPrices, NOW);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(w.orgBilling.rows[0]).toMatchObject({ plan: 'basic', billingInterval: 'year' });
  });
});

describe('Stripe request builders', () => {
  it('anchors a new subscription to the next 1st when asked', () => {
    expect(checkoutSubscriptionData({ orgId: ORG, anchor: true, now: NOW })).toEqual({
      metadata: { orgId: ORG },
      billing_cycle_anchor: Date.UTC(2026, 9, 1) / 1000,
      proration_behavior: 'create_prorations',
    });
  });

  it('adds no anchor otherwise', () => {
    const d = checkoutSubscriptionData({ orgId: ORG, anchor: false, now: NOW });
    expect(d).toEqual({ metadata: { orgId: ORG } });
    expect('billing_cycle_anchor' in d).toBe(false);
  });

  it('restarts and charges now when the interval changes', () => {
    expect(switchParams({ current: 'month', target: 'year' })).toEqual({
      billing_cycle_anchor: 'now',
      proration_behavior: 'always_invoice',
    });
    expect(switchParams({ current: 'year', target: 'month' }).billing_cycle_anchor).toBe('now');
  });

  it('keeps the billing date for a plan change in the same interval', () => {
    const p = switchParams({ current: 'month', target: 'month' });
    expect(p).toEqual({ proration_behavior: 'create_prorations' });
    expect('billing_cycle_anchor' in p).toBe(false);
  });

  it('refuses a billing date choice while a subscription is live', () => {
    for (const status of ['active', 'trialing', 'past_due'])
      expect(() => assertAnchorChangeAllowed({ status })).toThrow();
    for (const status of ['none', 'canceled', 'incomplete_expired'])
      expect(() => assertAnchorChangeAllowed({ status })).not.toThrow();
  });
});

describe('edge cases', () => {
  it('anchors across a year boundary', () => {
    const d = checkoutSubscriptionData({
      orgId: ORG,
      anchor: true,
      now: new Date('2026-12-31T23:59:59Z'),
    });
    expect(d.billing_cycle_anchor).toBe(Date.UTC(2027, 0, 1) / 1000);
  });

  it('does not recognise a yearly price when yearly prices are not configured', () => {
    expect(planAndIntervalForPrice(prices, 'price_pro_y')).toBeNull();
  });

  it('keeps plan and interval when a subscription has no items', async () => {
    const w = world();
    await applyStripeSubscription(w.db, sub('price_pro_y'), yearlyPrices, NOW);
    await applyStripeSubscription(w.db, { ...sub('x'), items: { data: [] } }, yearlyPrices, NOW);
    expect(w.orgBilling.rows[0]).toMatchObject({ plan: 'pro', billingInterval: 'year' });
  });
});
