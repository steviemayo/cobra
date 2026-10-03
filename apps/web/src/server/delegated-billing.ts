import type { PrismaClient } from '@kestrel/db';
import type { BillingInterval, PaidPlan } from '@kestrel/model';
import { writeAudit } from './audit';
import { NO_DELEGATION, PAYING_STATUSES, ensureBilling, type EntitlementDb } from './billing';
import { recordStaffAudit, type StaffDb } from './staff';

// Delegated billing (BD-5..BD-14): a customer organisation hands its Kestrel bill to a connected
// service provider. The provider pays Kestrel and re-bills the customer outside Kestrel. Each
// delegated customer has its own Stripe subscription on the provider's Stripe customer, so the
// customer's plan, status and room count stay on its own OrgBilling row and entitlements work as
// they always did. Stripe is reached only through `DelegationEffects`, so all of this is testable.

export class DelegationError extends Error {}

export type DelegationDb = EntitlementDb &
  StaffDb &
  Pick<PrismaClient, 'orgBilling' | 'mspGrant' | 'auditLog'>;

export type DelegationStatus = 'none' | 'requested' | 'active' | 'ending';
export type DelegationAuthor = 'customer' | 'provider' | 'grant' | 'staff';

export interface CodeDiscount {
  promotionCodeId: string;
  /** Null for a fixed-amount code, which cannot be compared with a percentage. */
  percentOff: number | null;
}

export interface StartedSubscription {
  subscriptionId: string;
  itemId: string | null;
  status: string;
  currentPeriodEnd: Date | null;
  collectionMethod: 'charge_automatically' | 'send_invoice';
}

/** The pieces of Stripe delegation touches. */
export interface DelegationEffects {
  hasPaymentMethod(customerId: string): Promise<boolean>;
  /** A usable promotion code, or null when it does not exist or is not active. */
  resolveCode(code: string): Promise<CodeDiscount | null>;
  /** A forever coupon for a percentage, reusing `existingId` when there is one. */
  couponForPercent(percent: number, existingId: string | null): Promise<string>;
  startSubscription(args: {
    customerOrgId: string;
    payerOrgId: string;
    payerCustomerId: string;
    priceId: string;
    quantity: number;
    /** No charge until then: when the customer's direct subscription ends (BD-9). */
    trialEnd: Date | null;
    discount: { promotionCodeId?: string; couponId?: string } | null;
    /** Days to pay when the provider is invoiced; null to charge its card. */
    invoiceDays: number | null;
  }): Promise<StartedSubscription>;
  /** Stops a subscription at the end of its period and returns that date. */
  cancelAtPeriodEnd(subscriptionId: string): Promise<Date | null>;
  /** Undoes `cancelAtPeriodEnd`. */
  keepRunning(subscriptionId: string): Promise<void>;
  cancelNow(subscriptionId: string): Promise<void>;
}

export { NO_DELEGATION };

/** Which discount a provider gets: the larger of its standing one and a code it typed. They never stack. */
export function chooseDiscount(
  standingPercent: number | null | undefined,
  code: CodeDiscount | null,
): 'standing' | 'code' | 'none' {
  const standing = standingPercent && standingPercent > 0 ? standingPercent : 0;
  if (!code) return standing ? 'standing' : 'none';
  if (!standing) return 'code';
  // A fixed-amount code cannot be compared; the provider typed it, so it wins.
  if (code.percentOff === null) return 'code';
  return code.percentOff >= standing ? 'code' : 'standing';
}

/** Staff set a standing percentage: a whole number from 1 to 100, or null to clear it. */
export function validDiscountPercent(percent: number | null): number | null {
  if (percent === null) return null;
  if (!Number.isInteger(percent) || percent < 1 || percent > 100)
    throw new DelegationError('A discount is a whole number from 1 to 100 percent.');
  return percent;
}

/** An active, unexpired connection between a provider and a customer. */
export async function activeConnection(
  db: Pick<PrismaClient, 'mspGrant'>,
  mspOrgId: string,
  customerOrgId: string,
  now = new Date(),
) {
  const g = await db.mspGrant.findFirst({ where: { mspOrgId, customerOrgId, status: 'active' } });
  return g && (!g.endsAt || g.endsAt.getTime() > now.getTime()) ? g : null;
}

const NO_CONNECTION =
  'That provider is not connected to your organisation. Connect them first, then ask again.';

/** The customer's owner asks a connected provider to pay. Nothing changes until the provider accepts. */
export async function requestDelegation(
  db: DelegationDb,
  args: { orgId: string; userId: string; providerOrgId: string; now?: Date },
): Promise<void> {
  const now = args.now ?? new Date();
  if (args.orgId === args.providerOrgId)
    throw new DelegationError('An organisation cannot pay for itself this way.');
  const b = await ensureBilling(db, args.orgId, now);
  if (b.delegationStatus === 'requested')
    throw new DelegationError('You already have a request waiting. Cancel it to ask someone else.');
  if (b.delegationStatus === 'active')
    throw new DelegationError('Billing is already handled by a provider.');
  if (b.delegationStatus === 'ending')
    throw new DelegationError(
      'Your provider’s billing is ending. Set up direct billing, or wait until it has ended.',
    );
  if (!(await activeConnection(db, args.providerOrgId, args.orgId, now)))
    throw new DelegationError(NO_CONNECTION);
  await db.orgBilling.update({
    where: { id: b.id },
    data: {
      delegationStatus: 'requested',
      payerOrgId: args.providerOrgId,
      delegationRequestedAt: now,
      delegationRequestedBy: args.userId,
      delegationDecidedAt: null,
      delegationDecidedBy: null,
      delegationDeclineReason: null,
    },
  });
  const meta = { customer: args.orgId, provider: args.providerOrgId };
  await writeAudit(
    {
      orgId: args.orgId,
      actorId: args.userId,
      action: 'billing.delegation_request',
      target: args.providerOrgId,
      meta,
    },
    db,
  );
  await writeAudit(
    {
      orgId: args.providerOrgId,
      actorId: null,
      action: 'billing.delegation_requested',
      target: args.orgId,
      meta,
    },
    db,
  );
}

/** The customer withdraws a request that is still waiting. */
export async function cancelDelegationRequest(
  db: DelegationDb,
  args: { orgId: string; userId: string },
): Promise<void> {
  const b = await ensureBilling(db, args.orgId);
  if (b.delegationStatus !== 'requested')
    throw new DelegationError('There is no request to cancel.');
  const provider = b.payerOrgId;
  await db.orgBilling.update({
    where: { id: b.id },
    data: { delegationStatus: 'none', payerOrgId: null },
  });
  await writeAudit(
    {
      orgId: args.orgId,
      actorId: args.userId,
      action: 'billing.delegation_request_cancelled',
      target: provider ?? undefined,
    },
    db,
  );
}

async function requestedBy(db: DelegationDb, providerOrgId: string, customerOrgId: string) {
  const b = await db.orgBilling.findFirst({ where: { orgId: customerOrgId } });
  if (!b || b.delegationStatus !== 'requested' || b.payerOrgId !== providerOrgId)
    throw new DelegationError('That request is no longer waiting.');
  return b;
}

/** The provider says no. The reason is shown to the customer's owner. */
export async function declineDelegation(
  db: DelegationDb,
  args: {
    providerOrgId: string;
    customerOrgId: string;
    userId: string;
    reason: string;
    now?: Date;
  },
): Promise<void> {
  const reason = args.reason.trim();
  if (reason.length < 5) throw new DelegationError('Give a reason of at least 5 characters.');
  if (reason.length > 500) throw new DelegationError('Keep the reason under 500 characters.');
  const b = await requestedBy(db, args.providerOrgId, args.customerOrgId);
  await db.orgBilling.update({
    where: { id: b.id },
    data: {
      delegationStatus: 'none',
      payerOrgId: null,
      delegationDecidedAt: args.now ?? new Date(),
      delegationDecidedBy: args.userId,
      delegationDeclineReason: reason,
    },
  });
  await writeAudit(
    {
      orgId: args.customerOrgId,
      actorId: null,
      action: 'billing.delegation_declined',
      target: args.providerOrgId,
      meta: { reason },
    },
    db,
  );
  await writeAudit(
    {
      orgId: args.providerOrgId,
      actorId: args.userId,
      action: 'billing.delegation_decline',
      target: args.customerOrgId,
      meta: { reason },
    },
    db,
  );
}

/** Whether a provider can pay: it has a Stripe customer, and a card on file or approved invoice billing. */
export async function providerReadiness(
  db: Pick<PrismaClient, 'orgBilling' | 'org'> & EntitlementDb,
  effects: Pick<DelegationEffects, 'hasPaymentMethod'>,
  providerOrgId: string,
): Promise<{ ok: true; invoiced: boolean; invoiceDays: number } | { ok: false; reason: string }> {
  const b = await ensureBilling(db, providerOrgId);
  const invoiced = b.invoiceStatus === 'approved';
  if (!b.stripeCustomerId || (!invoiced && !(await effects.hasPaymentMethod(b.stripeCustomerId))))
    return {
      ok: false,
      reason:
        'Add a payment method to your organisation’s billing before taking over a customer’s billing.',
    };
  return { ok: true, invoiced, invoiceDays: b.invoiceDays };
}

export interface AcceptInput {
  providerOrgId: string;
  customerOrgId: string;
  userId: string;
  plan: PaidPlan;
  interval: BillingInterval;
  /** The Stripe price for that plan and interval, chosen by the caller from the server's settings. */
  priceId: string;
  /** Rooms being billed for today. */
  rooms: number;
  code?: string | null;
  now?: Date;
}

/**
 * The provider accepts. Its subscription for the customer starts at once, but charges nothing until the
 * customer's own direct subscription ends, and that one is stopped at its period end only after this
 * one exists (BD-9): there is no gap in access and never two live bills.
 */
export async function acceptDelegation(
  db: DelegationDb,
  effects: DelegationEffects,
  input: AcceptInput,
): Promise<{ handoverAt: Date | null }> {
  const now = input.now ?? new Date();
  const b = await requestedBy(db, input.providerOrgId, input.customerOrgId);
  if (!(await activeConnection(db, input.providerOrgId, input.customerOrgId, now)))
    throw new DelegationError(NO_CONNECTION);

  const ready = await providerReadiness(db, effects, input.providerOrgId);
  if (!ready.ok) throw new DelegationError(ready.reason);
  // An invoiced provider is billed yearly only (IB-1), so its customers are too.
  const interval: BillingInterval = ready.invoiced ? 'year' : input.interval;
  if (ready.invoiced && input.interval !== 'year')
    throw new DelegationError(
      'Your organisation is billed yearly by invoice, so this plan is yearly.',
    );

  const provider = await ensureBilling(db, input.providerOrgId, now);
  const payerCustomerId = provider.stripeCustomerId!;

  // A discount code is checked before anything is created.
  const typed = input.code?.trim();
  const code = typed ? await effects.resolveCode(typed) : null;
  if (typed && !code) throw new DelegationError('That discount code is not valid.');
  const pick = chooseDiscount(provider.providerDiscountPercent, code);
  let discount: { promotionCodeId?: string; couponId?: string } | null = null;
  if (pick === 'code') discount = { promotionCodeId: code!.promotionCodeId };
  else if (pick === 'standing') {
    const couponId = await effects.couponForPercent(
      provider.providerDiscountPercent!,
      provider.providerDiscountCouponId,
    );
    if (couponId !== provider.providerDiscountCouponId)
      await db.orgBilling.update({
        where: { id: provider.id },
        data: { providerDiscountCouponId: couponId },
      });
    discount = { couponId };
  }

  // Their direct subscription keeps running until its period ends; ours charges from then.
  const directId = b.stripeSubscriptionId;
  const direct =
    b.billedBy === 'self' && !!directId && PAYING_STATUSES.has(b.status) ? directId : null;
  let handoverAt: Date | null = null;
  if (direct) {
    if (!b.currentPeriodEnd)
      throw new DelegationError(
        'Your current subscription has no end date to hand over from yet. Try again shortly.',
      );
    if (b.currentPeriodEnd.getTime() > now.getTime() + 60_000) handoverAt = b.currentPeriodEnd;
  }

  const started = await effects.startSubscription({
    customerOrgId: input.customerOrgId,
    payerOrgId: input.providerOrgId,
    payerCustomerId,
    priceId: input.priceId,
    quantity: Math.max(1, Math.floor(input.rooms)),
    trialEnd: handoverAt,
    discount,
    invoiceDays: ready.invoiced ? ready.invoiceDays : null,
  });

  if (direct) {
    try {
      await effects.cancelAtPeriodEnd(direct);
    } catch (e) {
      // Never leave two live subscriptions: undo ours and let them try again.
      await effects.cancelNow(started.subscriptionId).catch(() => undefined);
      console.error('[billing] could not stop the direct subscription', e);
      throw new DelegationError(
        'Could not stop the direct subscription, so nothing was changed. Try again shortly.',
      );
    }
  }

  await db.orgBilling.update({
    where: { id: b.id },
    data: {
      billedBy: 'provider',
      delegationStatus: 'active',
      delegationDecidedAt: now,
      delegationDecidedBy: input.userId,
      delegationDeclineReason: null,
      delegationHandoverAt: handoverAt,
      delegationFromSubscriptionId: direct,
      delegationEndsAt: null,
      stripeSubscriptionId: started.subscriptionId,
      stripeItemId: started.itemId,
      status: started.status,
      plan: input.plan,
      billingInterval: interval,
      collectionMethod: started.collectionMethod,
      quantity: Math.max(1, Math.floor(input.rooms)),
      currentPeriodEnd: started.currentPeriodEnd,
      cancelAtPeriodEnd: false,
      openInvoiceId: null,
      openInvoiceUrl: null,
      openInvoiceDueAt: null,
    },
  });
  const meta = {
    plan: input.plan,
    interval,
    rooms: input.rooms,
    discount: pick,
    handoverAt: handoverAt?.toISOString() ?? null,
  };
  await writeAudit(
    {
      orgId: input.customerOrgId,
      actorId: null,
      action: 'billing.delegation_accepted',
      target: input.providerOrgId,
      meta,
    },
    db,
  );
  await writeAudit(
    {
      orgId: input.providerOrgId,
      actorId: input.userId,
      action: 'billing.delegation_accept',
      target: input.customerOrgId,
      meta,
    },
    db,
  );
  return { handoverAt };
}

export type EndOutcome = 'none' | 'request_cancelled' | 'stopped' | 'ending' | 'already_ending';

/**
 * Ends a delegation, from either side, when the connection ends, or by staff. Before the provider's
 * subscription has started charging, the customer's direct subscription is kept and the provider's is
 * dropped. After, the provider's stops at its period end and the customer is warned to set up direct
 * billing before then (BD-10).
 */
export async function endDelegation(
  db: DelegationDb,
  effects: DelegationEffects,
  args: {
    customerOrgId: string;
    by: DelegationAuthor;
    userId: string | null;
    staffUserId?: string;
    now?: Date;
  },
): Promise<EndOutcome> {
  const now = args.now ?? new Date();
  const b = await ensureBilling(db, args.customerOrgId, now);
  const provider = b.payerOrgId;
  const log = async (action: string, meta: Record<string, unknown> = {}) => {
    const m = { by: args.by, ...meta };
    await writeAudit(
      {
        orgId: args.customerOrgId,
        actorId: args.userId,
        action,
        target: provider ?? undefined,
        meta: m,
      },
      db,
    );
    if (provider)
      await writeAudit(
        { orgId: provider, actorId: null, action, target: args.customerOrgId, meta: m },
        db,
      );
    if (args.staffUserId)
      await recordStaffAudit(db, {
        staffUserId: args.staffUserId,
        action,
        orgId: args.customerOrgId,
        meta: m,
      });
  };

  if (b.delegationStatus === 'none') return 'none';
  if (b.delegationStatus === 'ending') return 'already_ending';
  if (b.delegationStatus === 'requested') {
    await db.orgBilling.update({
      where: { id: b.id },
      data: { delegationStatus: 'none', payerOrgId: null },
    });
    await log('billing.delegation_request_ended');
    return 'request_cancelled';
  }

  const subId = b.stripeSubscriptionId;
  const notCharging = !!b.delegationHandoverAt && b.delegationHandoverAt.getTime() > now.getTime();
  if (notCharging && subId) {
    // Nothing has been charged: put the direct subscription back and drop the provider's.
    if (b.delegationFromSubscriptionId) await effects.keepRunning(b.delegationFromSubscriptionId);
    await effects.cancelNow(subId);
    await db.orgBilling.update({
      where: { id: b.id },
      data: {
        ...NO_DELEGATION,
        stripeSubscriptionId: b.delegationFromSubscriptionId,
        // The direct subscription's own events fill in the item, interval and period again.
        stripeItemId: null,
        ...(b.delegationFromSubscriptionId ? {} : { status: 'canceled' }),
      },
    });
    await log('billing.delegation_ended', { immediate: true });
    return 'stopped';
  }

  const endsAt = subId ? await effects.cancelAtPeriodEnd(subId) : null;
  await db.orgBilling.update({
    where: { id: b.id },
    data: { delegationStatus: 'ending', delegationEndsAt: endsAt ?? b.currentPeriodEnd },
  });
  await log('billing.delegation_ending', {
    endsAt: (endsAt ?? b.currentPeriodEnd)?.toISOString() ?? null,
  });
  return 'ending';
}

/**
 * A connection between a provider and a customer has ended or expired: any delegation between them
 * ends the same way (BD-7). Returns what happened, or null when there was nothing to end.
 */
export async function endDelegationForConnection(
  db: DelegationDb,
  effects: DelegationEffects,
  args: { mspOrgId: string; customerOrgId: string; now?: Date },
): Promise<EndOutcome | null> {
  const b = await db.orgBilling.findFirst({ where: { orgId: args.customerOrgId } });
  if (!b || b.payerOrgId !== args.mspOrgId || b.delegationStatus === 'none') return null;
  return endDelegation(db, effects, {
    customerOrgId: args.customerOrgId,
    by: 'grant',
    userId: null,
    now: args.now,
  });
}

/** Ends every delegation whose connection is no longer active. Run with the daily sweep. */
export async function endOrphanedDelegations(
  db: DelegationDb,
  effects: DelegationEffects,
  now = new Date(),
): Promise<number> {
  const rows = (
    await db.orgBilling.findMany({ where: { delegationStatus: { in: ['requested', 'active'] } } })
  ).filter((b) => b.payerOrgId);
  let ended = 0;
  for (const b of rows) {
    if (await activeConnection(db, b.payerOrgId!, b.orgId, now)) continue;
    try {
      await endDelegationForConnection(db, effects, {
        mspOrgId: b.payerOrgId!,
        customerOrgId: b.orgId,
        now,
      });
      ended++;
    } catch (e) {
      console.error('[billing] could not end delegation for', b.orgId, e);
    }
  }
  return ended;
}

export interface DelegationRequestView {
  orgId: string;
  orgName: string;
  requestedAt: Date | null;
  rooms: number;
}

export interface DelegatedCustomerView {
  orgId: string;
  orgName: string;
  plan: string;
  interval: string;
  rooms: number;
  status: 'active' | 'ending';
  /** The customer's direct subscription ends then and the provider's starts charging. */
  handoverAt: Date | null;
  endsAt: Date | null;
}

async function namesOf(db: Pick<PrismaClient, 'org'>, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const orgs = await db.org.findMany({ where: { id: { in: ids } } });
  return new Map(orgs.map((o) => [o.id, o.name]));
}

/** Customers waiting for this provider to take over their billing, oldest first. */
export async function requestsForProvider(
  db: DelegationDb,
  providerOrgId: string,
  roomsOf: (orgId: string) => Promise<number>,
): Promise<DelegationRequestView[]> {
  const rows = await db.orgBilling.findMany({
    where: { payerOrgId: providerOrgId, delegationStatus: 'requested' },
    orderBy: { delegationRequestedAt: 'asc' },
  });
  const names = await namesOf(
    db,
    rows.map((r) => r.orgId),
  );
  return Promise.all(
    rows.map(async (r) => ({
      orgId: r.orgId,
      orgName: names.get(r.orgId) ?? 'Unknown organisation',
      requestedAt: r.delegationRequestedAt,
      rooms: await roomsOf(r.orgId),
    })),
  );
}

/** The customers this provider is paying for now. */
export async function delegatedCustomers(
  db: DelegationDb,
  providerOrgId: string,
): Promise<DelegatedCustomerView[]> {
  const rows = await db.orgBilling.findMany({
    where: { payerOrgId: providerOrgId, delegationStatus: { in: ['active', 'ending'] } },
  });
  const names = await namesOf(
    db,
    rows.map((r) => r.orgId),
  );
  return rows.map((r) => ({
    orgId: r.orgId,
    orgName: names.get(r.orgId) ?? 'Unknown organisation',
    plan: r.plan,
    interval: r.billingInterval,
    rooms: r.quantity,
    status: r.delegationStatus === 'ending' ? 'ending' : 'active',
    handoverAt: r.delegationHandoverAt,
    endsAt: r.delegationEndsAt,
  }));
}

/** Staff set (or clear) the standing discount on a provider. It applies to subscriptions started from now on. */
export async function setProviderDiscount(
  db: DelegationDb,
  args: { orgId: string; staffUserId: string; percent: number | null },
): Promise<void> {
  const percent = validDiscountPercent(args.percent);
  const b = await ensureBilling(db, args.orgId);
  if (percent === b.providerDiscountPercent) return;
  // The coupon belongs to one percentage, so a new one is made on next use.
  await db.orgBilling.update({
    where: { id: b.id },
    data: { providerDiscountPercent: percent, providerDiscountCouponId: null },
  });
  await recordStaffAudit(db, {
    staffUserId: args.staffUserId,
    action: 'billing.provider_discount',
    orgId: args.orgId,
    meta: { from: b.providerDiscountPercent, to: percent },
  });
}
