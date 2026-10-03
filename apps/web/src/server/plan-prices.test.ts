import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  billableQuantity,
  clearPlanPriceCache,
  loadPlanPrices,
  toPlanPrice,
  totalFor,
  type StripePriceLike,
} from './plan-prices';

const price = (over: Partial<StripePriceLike> = {}): StripePriceLike => ({
  unit_amount: 1000,
  currency: 'AUD',
  tax_behavior: 'exclusive',
  recurring: { interval: 'month', interval_count: 1 },
  ...over,
});

describe('toPlanPrice', () => {
  it('reads the amount, lower cases the currency and keeps the tax setting', () => {
    expect(toPlanPrice('basic', 'month', price())).toEqual({
      plan: 'basic',
      interval: 'month',
      unitAmount: 1000,
      currency: 'aud',
      tax: 'exclusive',
    });
  });

  it('treats an unset tax behaviour as unspecified', () => {
    expect(toPlanPrice('pro', 'month', price({ tax_behavior: null }))?.tax).toBe('unspecified');
    expect(toPlanPrice('pro', 'month', price({ tax_behavior: 'unspecified' }))?.tax).toBe(
      'unspecified',
    );
  });

  it('refuses a price with no single per-room amount, or on another interval', () => {
    expect(toPlanPrice('basic', 'month', price({ unit_amount: null }))).toBeNull();
    expect(toPlanPrice('basic', 'month', price({ recurring: { interval: 'year' } }))).toBeNull();
    expect(
      toPlanPrice('basic', 'month', price({ recurring: { interval: 'month', interval_count: 3 } })),
    ).toBeNull();
    expect(toPlanPrice('basic', 'month', price({ recurring: null }))).toBeNull();
  });
});

describe('totals', () => {
  it('multiplies by rooms and never bills fewer than one', () => {
    expect(totalFor(1000, 42)).toBe(42000);
    expect(totalFor(1000, 0)).toBe(1000);
    expect(billableQuantity(-3)).toBe(1);
    expect(billableQuantity(2.9)).toBe(2);
    expect(billableQuantity(Number.NaN)).toBe(1);
  });
});

describe('loadPlanPrices', () => {
  beforeEach(clearPlanPriceCache);
  const map = { basic: 'p_b', pro: 'p_p', basicYearly: 'p_by', proYearly: 'p_py' };
  const source = (fail: string[] = []) => ({
    prices: {
      retrieve: vi.fn(async (id: string) => {
        if (fail.includes(id)) throw new Error('No such price');
        return price({
          unit_amount: id.endsWith('y') ? 10000 : 1000,
          recurring: { interval: id.endsWith('y') ? 'year' : 'month' },
        });
      }),
    },
  });

  it('loads every configured price and caches them for an hour', async () => {
    const s = source();
    const first = await loadPlanPrices(s, map, 0);
    expect(first).toHaveLength(4);
    await loadPlanPrices(s, map, 59 * 60_000);
    expect(s.prices.retrieve).toHaveBeenCalledTimes(4);
    await loadPlanPrices(s, map, 61 * 60_000);
    expect(s.prices.retrieve).toHaveBeenCalledTimes(8);
  });

  it('only asks for prices that are configured', async () => {
    const s = source();
    const got = await loadPlanPrices(s, { basic: 'p_b', pro: 'p_p' }, 0);
    expect(got.map((p) => `${p.plan}/${p.interval}`).sort()).toEqual(['basic/month', 'pro/month']);
    expect(s.prices.retrieve).toHaveBeenCalledTimes(2);
  });

  it('leaves out a price Stripe cannot find and does not cache the gap', async () => {
    const s = source(['p_p']);
    const got = await loadPlanPrices(s, map, 0);
    expect(got.some((p) => p.plan === 'pro' && p.interval === 'month')).toBe(false);
    await loadPlanPrices(s, map, 1000);
    expect(s.prices.retrieve).toHaveBeenCalledTimes(8);
  });
});
