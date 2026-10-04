import type { BillingInterval, PaidPlan } from '@kestrel/model';
import { priceIdFor, type PriceMap } from './billing';

// What each paid plan costs per room, read from Stripe (BD-2). Prices are never kept in code, so a
// price changed in Stripe shows up here within the cache time.

export interface PlanPrice {
  plan: PaidPlan;
  interval: BillingInterval;
  /** Per room, in the currency's smallest unit (cents). */
  unitAmount: number;
  /** Lower case ISO code, as Stripe sends it. */
  currency: string;
  /** Whether Stripe adds tax on top: "exclusive", already in the price: "inclusive", or not set. */
  tax: 'inclusive' | 'exclusive' | 'unspecified';
}

/** The parts of a Stripe price this reads, so tests need no Stripe. */
export interface StripePriceLike {
  unit_amount: number | null;
  currency: string;
  tax_behavior?: string | null;
  recurring?: { interval?: string | null; interval_count?: number | null } | null;
}

export interface PriceSource {
  prices: { retrieve(id: string): Promise<StripePriceLike> };
}

/**
 * One Stripe price as a plan price, or null when it cannot be shown honestly: tiered or metered
 * prices have no single per-room amount, and a price on another interval than the one asked for
 * would be mislabelled.
 */
export function toPlanPrice(
  plan: PaidPlan,
  interval: BillingInterval,
  p: StripePriceLike,
): PlanPrice | null {
  if (p.unit_amount === null || p.unit_amount < 0) return null;
  if (p.recurring?.interval !== interval || (p.recurring.interval_count ?? 1) !== 1) return null;
  return {
    plan,
    interval,
    unitAmount: p.unit_amount,
    currency: p.currency.toLowerCase(),
    tax:
      p.tax_behavior === 'inclusive' || p.tax_behavior === 'exclusive'
        ? p.tax_behavior
        : 'unspecified',
  };
}

/** Rooms that would be billed: a subscription is never for fewer than one. */
export const billableQuantity = (rooms: number): number =>
  Math.max(1, Math.floor(Number.isFinite(rooms) ? rooms : 0));

/** Total for a number of rooms, in the smallest currency unit. */
export const totalFor = (unitAmount: number, rooms: number): number =>
  unitAmount * billableQuantity(rooms);

const CACHE_MS = 60 * 60 * 1000;
let cache: { at: number; key: string; prices: PlanPrice[] } | null = null;

/** For tests. */
export const clearPlanPriceCache = () => {
  cache = null;
};

/**
 * Every configured plan price. A price Stripe cannot find, or that cannot be shown per room, is
 * left out (the page then says "price on request" for it). Cached for an hour per price set.
 */
export async function loadPlanPrices(
  stripe: PriceSource,
  map: PriceMap,
  now = Date.now(),
): Promise<PlanPrice[]> {
  const wanted = (['basic', 'pro'] as const).flatMap((plan) =>
    (['month', 'year'] as const).flatMap((interval) => {
      const id = priceIdFor(map, plan, interval);
      return id ? [{ plan, interval, id }] : [];
    }),
  );
  const key = wanted.map((w) => w.id).join(',');
  if (cache && cache.key === key && now - cache.at < CACHE_MS) return cache.prices;

  const found = await Promise.all(
    wanted.map(async (w) => {
      try {
        return toPlanPrice(w.plan, w.interval, await stripe.prices.retrieve(w.id));
      } catch (e) {
        console.error('[billing] could not read price', w.id, e);
        return null;
      }
    }),
  );
  const prices = found.filter((p): p is PlanPrice => !!p);
  // A failed read is not cached for an hour: the next visit tries again.
  if (prices.length === wanted.length) cache = { at: now, key, prices };
  return prices;
}
