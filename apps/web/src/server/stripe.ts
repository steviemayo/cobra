import 'server-only';
import Stripe from 'stripe';
import { headers } from 'next/headers';
import type { BillingInterval, PaidPlan } from '@kestrel/model';
import {
  PAYING_STATUSES,
  assertAnchorChangeAllowed,
  checkoutSubscriptionData,
  ensureBilling,
  monitoredRoomIds,
  priceIdFor,
  priceMapFromEnv,
  switchParams,
  type BillingDb,
} from './billing';
import type { DelegationEffects } from './delegated-billing';
import { assertInvoiceAllowed, invoiceSubscriptionParams } from './invoice-billing';

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
export async function baseUrl(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/$/, '');
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  if (!host) throw new Error('Cannot work out the portal address');
  return `${h.get('x-forwarded-proto') ?? 'https'}://${host}`;
}

function priceFor(plan: PaidPlan, interval: BillingInterval): string {
  const id = priceIdFor(priceMapFromEnv(), plan, interval);
  if (!id)
    throw new BillingNotConfigured(
      interval === 'year' ? `The yearly ${plan} plan` : `The ${plan} plan`,
    );
  return id;
}

const PAYING = PAYING_STATUSES;

/**
 * Sends the owner to Stripe to subscribe. If they already have a live subscription, the plan is
 * switched in place instead, so they are never billed twice.
 */
export async function startSubscription(
  db: BillingDb,
  input: {
    orgId: string;
    plan: PaidPlan;
    interval?: BillingInterval;
    /** Bill on the 1st of each month. New subscriptions only. */
    anchorFirstOfMonth?: boolean;
    rooms: number;
    email: string | null;
    /** Start charging only from then, e.g. when a provider's billing ends (BD-10). Needs 48 hours or more. */
    startAt?: Date | null;
    /** Always go to Checkout, never switch the organisation's current subscription in place. */
    forceNew?: boolean;
  },
): Promise<{ url: string } | { changed: true }> {
  const stripe = getStripe();
  const billing = await ensureBilling(db, input.orgId);
  const interval = input.interval ?? 'month';
  const price = priceFor(input.plan, interval);
  const anchor = !!input.anchorFirstOfMonth;

  if (
    !input.forceNew &&
    billing.stripeSubscriptionId &&
    billing.stripeItemId &&
    PAYING.has(billing.status)
  ) {
    // The billing date cannot be chosen once subscribed.
    if (anchor) assertAnchorChangeAllowed(billing);
    const params = switchParams({
      current: billing.billingInterval as BillingInterval,
      target: interval,
    });
    await stripe.subscriptions.update(billing.stripeSubscriptionId, {
      items: [{ id: billing.stripeItemId, price, quantity: Math.max(1, input.rooms) }],
      ...params,
    });
    // An interval switch restarts the billing date from today, so it is no longer on the 1st.
    if (params.billing_cycle_anchor && billing.anchorFirstOfMonth)
      await db.orgBilling.update({
        where: { id: billing.id },
        data: { anchorFirstOfMonth: false },
      });
    return { changed: true };
  }

  // A new (or resubscribed) subscription: remember the date choice for display afterwards.
  await db.orgBilling.update({
    where: { id: billing.id },
    data: { anchorFirstOfMonth: anchor },
  });

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
    subscription_data: {
      ...checkoutSubscriptionData({ orgId: input.orgId, anchor }),
      // Stripe needs a trial end at least 48 hours away; closer than that, billing starts now.
      ...(!anchor && input.startAt && input.startAt.getTime() > Date.now() + 49 * 3_600_000
        ? { trial_end: Math.floor(input.startAt.getTime() / 1000) }
        : {}),
    },
    allow_promotion_codes: true,
    success_url: `${back}?checkout=success`,
    cancel_url: `${back}?checkout=cancelled`,
  });
  if (!session.url) throw new Error('Stripe did not return a checkout address');
  return { url: session.url };
}

/**
 * Starts (or switches to) a yearly subscription billed by invoice. Needs staff approval first. Stripe
 * emails the invoice, due in INVOICE_DAYS; access starts now and the year runs from today.
 */
export async function startInvoiceSubscription(
  db: BillingDb,
  input: {
    orgId: string;
    orgName: string;
    plan: PaidPlan;
    rooms: number;
    email: string | null;
  },
): Promise<{ invoiced: true }> {
  const stripe = getStripe();
  const billing = await ensureBilling(db, input.orgId);
  assertInvoiceAllowed(billing, 'year');
  const price = priceFor(input.plan, 'year');

  if (billing.stripeSubscriptionId && billing.stripeItemId && PAYING.has(billing.status)) {
    // Already subscribed (by card): move to a yearly plan billed by invoice. The date restarts today.
    await stripe.subscriptions.update(billing.stripeSubscriptionId, {
      items: [{ id: billing.stripeItemId, price, quantity: Math.max(1, input.rooms) }],
      collection_method: 'send_invoice',
      days_until_due: billing.invoiceDays,
      billing_cycle_anchor: 'now',
      proration_behavior: 'always_invoice',
    });
    return { invoiced: true };
  }

  let customer = billing.stripeCustomerId;
  if (!customer) {
    const created = await stripe.customers.create({
      name: input.orgName,
      ...(input.email ? { email: input.email } : {}),
      metadata: { orgId: input.orgId },
    });
    customer = created.id;
    await db.orgBilling.update({ where: { id: billing.id }, data: { stripeCustomerId: customer } });
  }
  await db.orgBilling.update({ where: { id: billing.id }, data: { anchorFirstOfMonth: false } });
  await stripe.subscriptions.create(
    invoiceSubscriptionParams({
      orgId: input.orgId,
      customer,
      price,
      quantity: input.rooms,
      days: billing.invoiceDays,
    }),
  );
  // The subscription and invoice webhooks record the rest.
  return { invoiced: true };
}

/** Applies a new days-to-pay to a running invoiced subscription, for invoices issued from now on. */
export async function updateInvoiceDays(subscriptionId: string, days: number): Promise<void> {
  await getStripe().subscriptions.update(subscriptionId, { days_until_due: days });
}

/** Whether the customer has a card (or other saved method) that can be charged. */
export async function customerHasCard(customerId: string): Promise<boolean> {
  const c = await getStripe().customers.retrieve(customerId);
  if (c.deleted) return false;
  return !!(c.invoice_settings?.default_payment_method || c.default_source);
}

/** Charges an open invoice to the customer's saved card. True if it was paid. */
export async function chargeInvoiceToCard(invoiceId: string): Promise<boolean> {
  const inv = await getStripe().invoices.pay(invoiceId);
  return inv.status === 'paid';
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

/** Keeps the billed quantity equal to the number of monitored rooms. Safe to call after every device change. */
export async function syncQuantity(db: BillingDb, orgId: string): Promise<void> {
  if (!stripeConfigured()) return;
  const billing = await ensureBilling(db, orgId);
  if (!billing.stripeSubscriptionId || !billing.stripeItemId || !PAYING.has(billing.status)) return;
  const rooms = Math.max(1, (await monitoredRoomIds(db, orgId)).size);
  if (rooms === billing.quantity) return;
  // True up: rooms added mid-cycle are invoiced now, pro rata to the end of the period. The next
  // renewal then bills every room in full, so they are aligned with the billing cycle. Without it,
  // (and when rooms are removed) the proration is credited or charged on the next invoice.
  await getStripe().subscriptionItems.update(billing.stripeItemId, {
    quantity: rooms,
    proration_behavior:
      billing.trueUp && rooms > billing.quantity ? 'always_invoice' : 'create_prorations',
  });
  await db.orgBilling.update({ where: { id: billing.id }, data: { quantity: rooms } });
}

/** Checkout for a one-off marketplace purchase. The template is granted when Stripe confirms payment. */
export async function startMarketplaceCheckout(input: {
  orgId: string;
  listing: { id: string; name: string; priceCents: number; currency: string };
  email: string | null;
}): Promise<string> {
  const stripe = getStripe();
  const back = `${await baseUrl()}/o/${input.orgId}/marketplace`;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    ...(input.email ? { customer_email: input.email } : {}),
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: input.listing.currency,
          unit_amount: input.listing.priceCents,
          product_data: { name: input.listing.name },
        },
      },
    ],
    // Read back by the webhook, which is what actually grants the template.
    metadata: { kind: 'marketplace', listingId: input.listing.id, orgId: input.orgId },
    success_url: `${back}?purchase=success`,
    cancel_url: `${back}?purchase=cancelled`,
  });
  if (!session.url) throw new Error('Stripe did not return a checkout address');
  return session.url;
}

// ---- Delegated billing (BD-5..BD-14) ---------------------------------------------------------------

/** The real Stripe behind `DelegationEffects`. */
export function delegationEffects(): DelegationEffects {
  const stripe = getStripe();
  const periodEnd = (sub: Stripe.Subscription): Date | null => {
    const end =
      sub.items.data[0]?.current_period_end ??
      (sub as unknown as { current_period_end?: number }).current_period_end;
    return end ? new Date(end * 1000) : null;
  };
  return {
    hasPaymentMethod: customerHasCard,
    async resolveCode(code) {
      const found = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
      const promo = found.data[0] as unknown as
        | {
            id: string;
            coupon?: string | { id: string; percent_off?: number | null };
            promotion?: { coupon?: string | { id: string; percent_off?: number | null } | null };
          }
        | undefined;
      if (!promo) return null;
      let coupon = promo.coupon ?? promo.promotion?.coupon ?? null;
      if (typeof coupon === 'string') coupon = await stripe.coupons.retrieve(coupon);
      return { promotionCodeId: promo.id, percentOff: coupon?.percent_off ?? null };
    },
    async couponForPercent(percent, existingId) {
      if (existingId) return existingId;
      const c = await stripe.coupons.create({
        percent_off: percent,
        duration: 'forever',
        name: `Provider discount ${percent}%`,
      });
      return c.id;
    },
    async startSubscription(a) {
      const invoiced = a.invoiceDays !== null;
      const sub = await stripe.subscriptions.create({
        customer: a.payerCustomerId,
        items: [{ price: a.priceId, quantity: a.quantity }],
        metadata: { orgId: a.customerOrgId, payerOrgId: a.payerOrgId },
        ...(a.trialEnd ? { trial_end: Math.floor(a.trialEnd.getTime() / 1000) } : {}),
        ...(a.discount?.promotionCodeId
          ? { discounts: [{ promotion_code: a.discount.promotionCodeId }] }
          : a.discount?.couponId
            ? { discounts: [{ coupon: a.discount.couponId }] }
            : {}),
        ...(invoiced
          ? { collection_method: 'send_invoice' as const, days_until_due: a.invoiceDays! }
          : { payment_behavior: 'error_if_incomplete' as const }),
      });
      return {
        subscriptionId: sub.id,
        itemId: sub.items.data[0]?.id ?? null,
        status: sub.status,
        currentPeriodEnd: periodEnd(sub),
        collectionMethod: invoiced ? 'send_invoice' : 'charge_automatically',
      };
    },
    async cancelAtPeriodEnd(id) {
      const sub = await stripe.subscriptions.update(id, { cancel_at_period_end: true });
      return periodEnd(sub);
    },
    async keepRunning(id) {
      await stripe.subscriptions.update(id, { cancel_at_period_end: false });
    },
    async cancelNow(id) {
      await stripe.subscriptions.cancel(id);
    },
  };
}

/**
 * Checkout in setup mode so an organisation can save a card without subscribing, e.g. a provider that
 * will pay for its customers. Creates the Stripe customer first when there is none yet.
 */
export async function startPaymentSetup(
  db: BillingDb,
  input: { orgId: string; orgName: string; email: string | null },
): Promise<string> {
  const stripe = getStripe();
  const billing = await ensureBilling(db, input.orgId);
  let customer = billing.stripeCustomerId;
  if (!customer) {
    const created = await stripe.customers.create({
      name: input.orgName,
      ...(input.email ? { email: input.email } : {}),
      metadata: { orgId: input.orgId },
    });
    customer = created.id;
    await db.orgBilling.update({ where: { id: billing.id }, data: { stripeCustomerId: customer } });
  }
  const back = `${await baseUrl()}/o/${input.orgId}/settings/billing`;
  const session = await stripe.checkout.sessions.create({
    mode: 'setup',
    customer,
    currency: 'aud',
    metadata: { kind: 'payer_setup', orgId: input.orgId },
    success_url: `${back}?setup=success`,
    cancel_url: `${back}?setup=cancelled`,
  });
  if (!session.url) throw new Error('Stripe did not return a checkout address');
  return session.url;
}

export interface PayerSetupSession {
  customer?: string | null;
  setup_intent?: string | { id: string; payment_method?: string | { id: string } | null } | null;
  metadata?: Record<string, string> | null;
}

/** A saved card becomes the customer's default, so subscriptions it pays for can charge it. */
export async function fulfilPayerSetup(session: PayerSetupSession): Promise<'saved' | 'ignored'> {
  if (!session.customer || !session.setup_intent) return 'ignored';
  const stripe = getStripe();
  const intent =
    typeof session.setup_intent === 'string'
      ? await stripe.setupIntents.retrieve(session.setup_intent)
      : session.setup_intent;
  const pm = intent.payment_method;
  const pmId = typeof pm === 'string' ? pm : pm?.id;
  if (!pmId) return 'ignored';
  await stripe.customers.update(session.customer, {
    invoice_settings: { default_payment_method: pmId },
  });
  return 'saved';
}

/** Stripe for delegation, or something that says payments are not set up when they are not. */
export function delegationEffectsOrUnavailable(): DelegationEffects {
  if (stripeConfigured()) return delegationEffects();
  const refuse = async (): Promise<never> => {
    throw new BillingNotConfigured();
  };
  return {
    hasPaymentMethod: refuse,
    resolveCode: refuse,
    couponForPercent: refuse,
    startSubscription: refuse,
    cancelAtPeriodEnd: refuse,
    keepRunning: refuse,
    cancelNow: refuse,
  };
}
