import type { PrismaClient } from '@kestrel/db';
import {
  TRIAL_DAYS,
  entitlementsWithOverride,
  overrideActive,
  type Entitlements,
  type Feature,
  type PaidPlan,
  type StoredPlan,
} from '@kestrel/model';

// Billing state and entitlements. Functions take the database as a parameter so they can be tested
// without one. Stripe itself is only touched in stripe.ts.
// The override table is optional so callers (and tests) that only deal in plans need not have it.
export type EntitlementDb = Pick<PrismaClient, 'orgBilling' | 'org'> &
  Partial<Pick<PrismaClient, 'orgLicenseOverride'>>;
export type BillingDb = EntitlementDb & Pick<PrismaClient, 'stripeEvent' | 'room'>;

export interface PriceMap {
  basic?: string;
  pro?: string;
}
export const priceMapFromEnv = (
  env: Record<string, string | undefined> = process.env,
): PriceMap => ({
  basic: env.STRIPE_PRICE_BASIC || undefined,
  pro: env.STRIPE_PRICE_PRO || undefined,
});
export const planForPrice = (prices: PriceMap, priceId: string | undefined): PaidPlan | null =>
  !priceId ? null : prices.basic === priceId ? 'basic' : prices.pro === priceId ? 'pro' : null;

/** The organisation's billing row, created on first use with a fresh trial. */
export async function ensureBilling(db: EntitlementDb, orgId: string, now = new Date()) {
  const existing = await db.orgBilling.findFirst({ where: { orgId } });
  if (existing) return existing;
  const org = await db.org.findFirst({ where: { id: orgId } });
  const start = org?.createdAt ?? now;
  return db.orgBilling.create({
    data: {
      orgId,
      plan: 'trial',
      status: 'none',
      trialEndsAt: new Date(start.getTime() + TRIAL_DAYS * 86_400_000),
    },
  });
}

/** The staff adjustment that applies to an organisation right now, if any: the newest one not revoked or expired. */
export async function activeOverride(db: EntitlementDb, orgId: string, now = new Date()) {
  const rows =
    (await db.orgLicenseOverride?.findMany({
      where: { orgId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    })) ?? [];
  return rows.find((r) => overrideActive(r, now)) ?? null;
}

export async function getEntitlements(
  db: EntitlementDb,
  orgId: string,
  now = new Date(),
): Promise<Entitlements> {
  const b = await ensureBilling(db, orgId, now);
  return entitlementsWithOverride(
    { plan: b.plan as StoredPlan, status: b.status, trialEndsAt: b.trialEndsAt },
    await activeOverride(db, orgId, now),
    now,
  );
}

/** Refuses with a message the portal turns into an "upgrade" prompt. */
export const PLAN_REQUIRED = 'PLAN_REQUIRED';
export function planRequired(feature: Feature): string {
  return `${PLAN_REQUIRED}:${feature}`;
}

/** Whether another room may be added, given how many the organisation has. */
export function canAddRoom(e: Entitlements, currentRooms: number): boolean {
  return e.maxRooms === null || currentRooms < e.maxRooms;
}

// ---- Stripe -> billing --------------------------------------------------------------------------

/** The parts of a Stripe subscription Kestrel reads. Kept minimal so SDK changes can't break it. */
export interface StripeSubscriptionLike {
  id: string;
  customer: string | { id: string };
  status: string;
  cancel_at_period_end?: boolean;
  current_period_end?: number;
  metadata?: Record<string, string> | null;
  items: {
    data: {
      id: string;
      quantity?: number | null;
      current_period_end?: number;
      price: { id: string };
    }[];
  };
}

const idOf = (c: string | { id: string }) => (typeof c === 'string' ? c : c.id);

/** Records a subscription's state against the organisation it belongs to. Returns false if it can't be matched. */
export async function applyStripeSubscription(
  db: BillingDb,
  sub: StripeSubscriptionLike,
  prices: PriceMap,
  now = new Date(),
): Promise<boolean> {
  const customer = idOf(sub.customer);
  const byCustomer = await db.orgBilling.findFirst({ where: { stripeCustomerId: customer } });
  const orgId = byCustomer?.orgId ?? sub.metadata?.orgId;
  if (!orgId) return false;
  const billing = await ensureBilling(db, orgId, now);
  // A customer created for one organisation must never be applied to another.
  if (billing.stripeCustomerId && billing.stripeCustomerId !== customer) return false;

  const item = sub.items.data[0];
  const plan = planForPrice(prices, item?.price.id);
  const periodEnd = item?.current_period_end ?? sub.current_period_end;
  await db.orgBilling.update({
    where: { id: billing.id },
    data: {
      stripeCustomerId: customer,
      stripeSubscriptionId: sub.id,
      stripeItemId: item?.id ?? null,
      status: sub.status,
      // An unknown price leaves the plan alone rather than guessing.
      ...(plan ? { plan } : {}),
      quantity: item?.quantity ?? billing.quantity,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    },
  });
  return true;
}

export interface StripeEventLike {
  id: string;
  type: string;
  data: { object: unknown };
}

/**
 * Handles one verified webhook event. Each event id is processed once, so Stripe redelivering
 * (or two deliveries racing) can't apply anything twice. Returns what happened, for logging.
 */
export async function handleStripeEvent(
  db: BillingDb,
  event: StripeEventLike,
  prices: PriceMap,
  now = new Date(),
): Promise<'applied' | 'duplicate' | 'ignored' | 'unmatched'> {
  if (await db.stripeEvent.findFirst({ where: { id: event.id } })) return 'duplicate';
  let result: 'applied' | 'ignored' | 'unmatched';
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as StripeSubscriptionLike;
      const ok = await applyStripeSubscription(
        db,
        event.type === 'customer.subscription.deleted' ? { ...sub, status: 'canceled' } : sub,
        prices,
        now,
      );
      result = ok ? 'applied' : 'unmatched';
      break;
    }
    case 'checkout.session.completed': {
      // Links the new Stripe customer to the organisation; the subscription events do the rest.
      const s = event.data.object as {
        client_reference_id?: string | null;
        customer?: string | null;
      };
      if (s.client_reference_id && s.customer) {
        const billing = await ensureBilling(db, s.client_reference_id, now);
        if (!billing.stripeCustomerId)
          await db.orgBilling.update({
            where: { id: billing.id },
            data: { stripeCustomerId: s.customer },
          });
        result = 'applied';
      } else result = 'unmatched';
      break;
    }
    default:
      result = 'ignored';
  }
  try {
    await db.stripeEvent.create({ data: { id: event.id, type: event.type, processedAt: now } });
  } catch (e) {
    // Another delivery of the same event got there first; it applied the same state.
    if ((e as { code?: string }).code === 'P2002') return 'duplicate';
    throw e;
  }
  return result;
}
