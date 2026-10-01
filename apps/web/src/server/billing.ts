import type { PrismaClient } from '@kestrel/db';
import {
  TRIAL_DAYS,
  nextFirstOfMonthUnix,
  type BillingInterval,
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
export type BillingDb = EntitlementDb &
  Pick<PrismaClient, 'stripeEvent' | 'room' | 'device' | 'deviceStatus'>;

export interface PriceMap {
  basic?: string;
  pro?: string;
  basicYearly?: string;
  proYearly?: string;
}
export const priceMapFromEnv = (
  env: Record<string, string | undefined> = process.env,
): PriceMap => ({
  basic: env.STRIPE_PRICE_BASIC || undefined,
  pro: env.STRIPE_PRICE_PRO || undefined,
  basicYearly: env.STRIPE_PRICE_BASIC_YEARLY || undefined,
  proYearly: env.STRIPE_PRICE_PRO_YEARLY || undefined,
});

/** Which plan and billing interval a Stripe price id stands for, or null if it is not one of ours. */
export function planAndIntervalForPrice(
  prices: PriceMap,
  priceId: string | undefined,
): { plan: PaidPlan; interval: BillingInterval } | null {
  if (!priceId) return null;
  if (prices.basic === priceId) return { plan: 'basic', interval: 'month' };
  if (prices.pro === priceId) return { plan: 'pro', interval: 'month' };
  if (prices.basicYearly === priceId) return { plan: 'basic', interval: 'year' };
  if (prices.proYearly === priceId) return { plan: 'pro', interval: 'year' };
  return null;
}
export const planForPrice = (prices: PriceMap, priceId: string | undefined): PaidPlan | null =>
  planAndIntervalForPrice(prices, priceId)?.plan ?? null;

/** The price id for a plan and interval, or undefined if it is not configured. */
export function priceIdFor(
  prices: PriceMap,
  plan: PaidPlan,
  interval: BillingInterval,
): string | undefined {
  return interval === 'year'
    ? plan === 'basic'
      ? prices.basicYearly
      : prices.proYearly
    : plan === 'basic'
      ? prices.basic
      : prices.pro;
}

/** Yearly billing is offered only when both yearly prices exist. */
export const yearlyAvailable = (prices: PriceMap): boolean =>
  !!prices.basicYearly && !!prices.proYearly;

/** Stripe statuses that count as a live subscription. */
export const PAYING_STATUSES = new Set(['active', 'trialing', 'past_due']);

/** Checkout's `subscription_data` for a new subscription, optionally anchored to the next 1st of the month. */
export function checkoutSubscriptionData(input: { orgId: string; anchor: boolean; now?: Date }) {
  return {
    metadata: { orgId: input.orgId },
    ...(input.anchor
      ? {
          billing_cycle_anchor: nextFirstOfMonthUnix(input.now ?? new Date()),
          proration_behavior: 'create_prorations' as const,
        }
      : {}),
  };
}

/**
 * What to send Stripe when switching an existing subscription. Changing between monthly and yearly
 * restarts the billing date and is charged now (with credit for unused time); a plan change within
 * the same interval keeps the date and prorates on the next invoice.
 */
export function switchParams(input: { current: BillingInterval; target: BillingInterval }): {
  proration_behavior: 'always_invoice' | 'create_prorations';
  billing_cycle_anchor?: 'now';
} {
  return input.current !== input.target
    ? { billing_cycle_anchor: 'now', proration_behavior: 'always_invoice' }
    : { proration_behavior: 'create_prorations' };
}

/** The 1st-of-the-month choice only applies to new subscriptions; refuses while one is live. */
export function assertAnchorChangeAllowed(billing: { status: string }): void {
  if (PAYING_STATUSES.has(billing.status))
    throw new Error('The billing date can only be chosen when you first subscribe.');
}

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

/** What to tell someone who cannot add a room: an ended trial adds none, a limit says what it is. */
export function roomLimitMessage(e: Entitlements): string {
  return e.maxRooms === 0
    ? 'Your trial has ended, so no new rooms can be added. Subscribe to add more.'
    : `Your plan includes ${e.maxRooms} rooms. Subscribe to add more.`;
}

export type BillingRoomsDb = Pick<PrismaClient, 'device' | 'deviceStatus' | 'room'> &
  Partial<Pick<PrismaClient, 'deviceRoom'>>;

/**
 * The rooms an organisation pays for: those with at least one monitored (active) device. A room of
 * only recorded assets, or with nothing in it, is free. Devices still inside older room designs
 * count until they are moved into the register. Staging and combined rooms are never counted. A room
 * that a shared monitored device is linked to (`DeviceRoom`) is monitored too, even with no device of
 * its own, so the rooms a shared DSP or control system serves are charged like any other.
 */
export async function monitoredRoomIds(db: BillingRoomsDb, orgId: string): Promise<Set<string>> {
  const [devices, legacy, rooms, links] = await Promise.all([
    db.device.findMany({ where: { orgId, kind: 'active' } }),
    db.deviceStatus.findMany({ where: { orgId } }),
    db.room.findMany({ where: { orgId } }),
    db.deviceRoom ? db.deviceRoom.findMany({ where: { orgId } }) : Promise.resolve([]),
  ]);
  const billed = new Set(
    rooms.filter((r) => !['staging', 'combined'].includes(r.kind ?? 'standard')).map((r) => r.id),
  );
  const ids = new Set<string>();
  for (const d of devices) if (d.roomId && billed.has(d.roomId)) ids.add(d.roomId);
  for (const d of legacy) if (billed.has(d.roomId)) ids.add(d.roomId);
  const active = new Set(devices.map((d) => d.id));
  for (const l of links) if (active.has(l.deviceId) && billed.has(l.roomId)) ids.add(l.roomId);
  return ids;
}

/** What to tell someone who cannot start monitoring another room. */
export function monitorLimitMessage(e: Entitlements): string {
  return e.maxRooms === 0
    ? 'Your trial has ended, so no more rooms can be monitored. Subscribe to add more.'
    : `Your plan includes ${e.maxRooms} monitored rooms. A room is monitored once it has a networked device with a driver. Subscribe to add more.`;
}

/** Whether a device may start being monitored in a room: rooms already monitored are free to add to. */
export async function canMonitorRoom(
  db: BillingRoomsDb,
  orgId: string,
  e: Entitlements,
  roomId: string | null,
): Promise<boolean> {
  if (e.maxRooms === null) return true;
  if (!roomId) return true; // not in a room, so not charged until it is
  const current = await monitoredRoomIds(db, orgId);
  return current.has(roomId) || current.size < e.maxRooms;
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
  const known = planAndIntervalForPrice(prices, item?.price.id);
  if (!known && item)
    console.warn('[billing] subscription', sub.id, 'has a price Kestrel does not recognise');
  const periodEnd = item?.current_period_end ?? sub.current_period_end;
  await db.orgBilling.update({
    where: { id: billing.id },
    data: {
      stripeCustomerId: customer,
      stripeSubscriptionId: sub.id,
      stripeItemId: item?.id ?? null,
      status: sub.status,
      // An unknown price leaves the plan and interval alone rather than guessing.
      ...(known ? { plan: known.plan, billingInterval: known.interval } : {}),
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
