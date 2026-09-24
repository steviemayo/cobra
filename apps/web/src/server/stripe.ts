import 'server-only';
import Stripe from 'stripe';
import { headers } from 'next/headers';
import type { PaidPlan } from '@kestrel/model';
import { ensureBilling, priceMapFromEnv, type BillingDb } from './billing';

export class BillingNotConfigured extends Error {
  constructor(what = 'Billing') {
    super(`${what} isn’t set up on this Kestrel server yet.`);
  }
}

let client: Stripe | null = null;
export const stripeConfigured = () => !!process.env.STRIPE_SECRET_KEY;

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new BillingNotConfigured();
  return (client ??= new Stripe(key));
}

/** The portal's public address, from config or from the request that is being served. */
async function baseUrl(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/$/, '');
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  if (!host) throw new Error('Cannot work out the portal address');
  return `${h.get('x-forwarded-proto') ?? 'https'}://${host}`;
}

function priceFor(plan: PaidPlan): string {
  const id = priceMapFromEnv()[plan];
  if (!id) throw new BillingNotConfigured(`The ${plan} plan`);
  return id;
}

const PAYING = new Set(['active', 'trialing', 'past_due']);

/**
 * Sends the owner to Stripe to subscribe. If they already have a live subscription, the plan is
 * switched in place instead, so they are never billed twice.
 */
export async function startSubscription(
  db: BillingDb,
  input: { orgId: string; plan: PaidPlan; rooms: number; email: string | null },
): Promise<{ url: string } | { changed: true }> {
  const stripe = getStripe();
  const billing = await ensureBilling(db, input.orgId);
  const price = priceFor(input.plan);

  if (billing.stripeSubscriptionId && billing.stripeItemId && PAYING.has(billing.status)) {
    await stripe.subscriptions.update(billing.stripeSubscriptionId, {
      items: [{ id: billing.stripeItemId, price, quantity: Math.max(1, input.rooms) }],
      proration_behavior: 'create_prorations',
    });
    return { changed: true };
  }

  const base = await baseUrl();
  const back = `${base}/o/${input.orgId}/settings/billing`;
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    client_reference_id: input.orgId,
    ...(billing.stripeCustomerId
      ? { customer: billing.stripeCustomerId }
      : input.email
        ? { customer_email: input.email }
        : {}),
    line_items: [{ price, quantity: Math.max(1, input.rooms) }],
    subscription_data: { metadata: { orgId: input.orgId } },
    allow_promotion_codes: true,
    success_url: `${back}?checkout=success`,
    cancel_url: `${back}?checkout=cancelled`,
  });
  if (!session.url) throw new Error('Stripe did not return a checkout address');
  return { url: session.url };
}

/** Stripe's own page for cards, invoices and cancelling. */
export async function billingPortalUrl(db: BillingDb, orgId: string): Promise<string> {
  const billing = await ensureBilling(db, orgId);
  if (!billing.stripeCustomerId) throw new Error('There is no subscription to manage yet');
  const session = await getStripe().billingPortal.sessions.create({
    customer: billing.stripeCustomerId,
    return_url: `${await baseUrl()}/o/${orgId}/settings/billing`,
  });
  return session.url;
}

/** Keeps the billed quantity equal to the number of rooms. Safe to call after every room change. */
export async function syncQuantity(db: BillingDb, orgId: string): Promise<void> {
  if (!stripeConfigured()) return;
  const billing = await ensureBilling(db, orgId);
  if (!billing.stripeSubscriptionId || !billing.stripeItemId || !PAYING.has(billing.status)) return;
  const rooms = Math.max(1, await db.room.count({ where: { orgId } }));
  if (rooms === billing.quantity) return;
  await getStripe().subscriptionItems.update(billing.stripeItemId, {
    quantity: rooms,
    proration_behavior: 'create_prorations',
  });
  await db.orgBilling.update({ where: { id: billing.id }, data: { quantity: rooms } });
}
