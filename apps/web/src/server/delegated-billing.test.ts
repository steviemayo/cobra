import { describe, expect, it, vi } from 'vitest';
import { applyStripeSubscription, type BillingDb, type StripeSubscriptionLike } from './billing';
import {
  DelegationError,
  acceptDelegation,
  cancelDelegationRequest,
  chooseDiscount,
  declineDelegation,
  delegatedCustomers,
  endDelegation,
  endDelegationForConnection,
  endOrphanedDelegations,
  requestDelegation,
  requestsForProvider,
  setProviderDiscount,
  validDiscountPercent,
  type DelegationDb,
  type DelegationEffects,
} from './delegated-billing';
import { applyStripeInvoice } from './invoice-billing';
import { table } from './test-db';

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const PROVIDER = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const STAFF = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-03T00:00:00Z');
const PERIOD_END = new Date('2026-11-01T00:00:00Z');
const PRICES = { basic: 'price_b', pro: 'price_p', basicYearly: 'price_by', proYearly: 'price_py' };

function world(
  opts: {
    customer?: Record<string, unknown>;
    provider?: Record<string, unknown>;
    grant?: Record<string, unknown> | null;
  } = {},
) {
  const orgBilling = table([
    {
      id: 'bc',
      orgId: CUSTOMER,
      plan: 'trial',
      status: 'none',
      billedBy: 'self',
      delegationStatus: 'none',
      payerOrgId: null,
      stripeCustomerId: 'cus_customer',
      stripeSubscriptionId: null,
      trialEndsAt: NOW,
      quantity: 0,
      ...opts.customer,
    },
    {
      id: 'bp',
      orgId: PROVIDER,
      plan: 'trial',
      status: 'none',
      billedBy: 'self',
      delegationStatus: 'none',
      invoiceStatus: 'none',
      invoiceDays: 14,
      stripeCustomerId: 'cus_provider',
      providerDiscountPercent: null,
      providerDiscountCouponId: null,
      trialEndsAt: NOW,
      ...opts.provider,
    },
  ]);
  const mspGrant = table(
    opts.grant === null
      ? []
      : [
          {
            id: 'g1',
            mspOrgId: PROVIDER,
            customerOrgId: CUSTOMER,
            status: 'active',
            endsAt: null,
            ...opts.grant,
          },
        ],
  );
  const auditLog = table([]);
  const staffAudit = table([]);
  const db = {
    orgBilling,
    mspGrant,
    auditLog,
    staffAudit,
    org: table([
      { id: CUSTOMER, name: 'Acme Customer', createdAt: NOW },
      { id: PROVIDER, name: 'Best AV', createdAt: NOW },
    ]),
    orgLicenseOverride: table([]),
    stripeEvent: table([]),
    room: table([]),
    device: table([]),
    deviceStatus: table([]),
  } as unknown as DelegationDb & BillingDb;
  const row = (id: string) => orgBilling.rows.find((r) => r.id === id)!;
  return {
    db,
    orgBilling,
    mspGrant,
    auditLog,
    staffAudit,
    customer: () => row('bc'),
    provider: () => row('bp'),
  };
}

function effects(over: Partial<DelegationEffects> = {}): DelegationEffects & {
  startSubscription: ReturnType<typeof vi.fn>;
  cancelAtPeriodEnd: ReturnType<typeof vi.fn>;
  keepRunning: ReturnType<typeof vi.fn>;
  cancelNow: ReturnType<typeof vi.fn>;
} {
  return {
    hasPaymentMethod: vi.fn(async () => true),
    resolveCode: vi.fn(async () => null),
    couponForPercent: vi.fn(async () => 'coupon_new'),
    startSubscription: vi.fn(async () => ({
      subscriptionId: 'sub_delegated',
      itemId: 'si_delegated',
      status: 'active',
      currentPeriodEnd: PERIOD_END,
      collectionMethod: 'charge_automatically' as const,
    })),
    cancelAtPeriodEnd: vi.fn(async () => PERIOD_END),
    keepRunning: vi.fn(async () => undefined),
    cancelNow: vi.fn(async () => undefined),
    ...over,
  } as never;
}

const accept = (
  w: ReturnType<typeof world>,
  fx: DelegationEffects,
  over: Record<string, unknown> = {},
) =>
  acceptDelegation(w.db, fx, {
    providerOrgId: PROVIDER,
    customerOrgId: CUSTOMER,
    userId: USER,
    plan: 'pro',
    interval: 'month',
    priceId: 'price_p',
    rooms: 12,
    now: NOW,
    ...over,
  } as never);

const requested = { delegationStatus: 'requested', payerOrgId: PROVIDER };

describe('chooseDiscount', () => {
  it('uses a standing discount when there is no code, and nothing when there is neither', () => {
    expect(chooseDiscount(10, null)).toBe('standing');
    expect(chooseDiscount(null, null)).toBe('none');
    expect(chooseDiscount(0, null)).toBe('none');
  });

  it('uses a code on its own, and the larger of the two when both exist', () => {
    expect(chooseDiscount(null, { promotionCodeId: 'p', percentOff: 5 })).toBe('code');
    expect(chooseDiscount(10, { promotionCodeId: 'p', percentOff: 20 })).toBe('code');
    expect(chooseDiscount(20, { promotionCodeId: 'p', percentOff: 10 })).toBe('standing');
    expect(chooseDiscount(15, { promotionCodeId: 'p', percentOff: 15 })).toBe('code');
  });

  it('lets a fixed-amount code win, since it cannot be compared', () => {
    expect(chooseDiscount(50, { promotionCodeId: 'p', percentOff: null })).toBe('code');
  });

  it('validates a standing percentage', () => {
    expect(validDiscountPercent(null)).toBeNull();
    expect(validDiscountPercent(25)).toBe(25);
    for (const bad of [0, 101, 2.5, -1])
      expect(() => validDiscountPercent(bad)).toThrow(DelegationError);
  });
});

describe('asking a provider to pay', () => {
  it('records a request without changing who pays', async () => {
    const w = world();
    await requestDelegation(w.db, {
      orgId: CUSTOMER,
      userId: USER,
      providerOrgId: PROVIDER,
      now: NOW,
    });
    expect(w.customer()).toMatchObject({
      billedBy: 'self',
      delegationStatus: 'requested',
      payerOrgId: PROVIDER,
      delegationRequestedBy: USER,
    });
    expect(w.auditLog.rows.map((r) => r.action)).toEqual([
      'billing.delegation_request',
      'billing.delegation_requested',
    ]);
  });

  it('needs an active connection that has not expired', async () => {
    const none = world({ grant: null });
    await expect(
      requestDelegation(none.db, {
        orgId: CUSTOMER,
        userId: USER,
        providerOrgId: PROVIDER,
        now: NOW,
      }),
    ).rejects.toThrow(/not connected/);
    const pending = world({ grant: { status: 'pending' } });
    await expect(
      requestDelegation(pending.db, {
        orgId: CUSTOMER,
        userId: USER,
        providerOrgId: PROVIDER,
        now: NOW,
      }),
    ).rejects.toThrow(/not connected/);
    const expired = world({ grant: { endsAt: new Date('2026-10-01T00:00:00Z') } });
    await expect(
      requestDelegation(expired.db, {
        orgId: CUSTOMER,
        userId: USER,
        providerOrgId: PROVIDER,
        now: NOW,
      }),
    ).rejects.toThrow(/not connected/);
  });

  it('refuses a second request, a request while a provider pays, and paying for itself', async () => {
    const waiting = world({ customer: requested });
    await expect(
      requestDelegation(waiting.db, { orgId: CUSTOMER, userId: USER, providerOrgId: PROVIDER }),
    ).rejects.toThrow(/already have a request/);
    const active = world({ customer: { delegationStatus: 'active', payerOrgId: PROVIDER } });
    await expect(
      requestDelegation(active.db, { orgId: CUSTOMER, userId: USER, providerOrgId: PROVIDER }),
    ).rejects.toThrow(/already handled/);
    await expect(
      requestDelegation(world().db, { orgId: CUSTOMER, userId: USER, providerOrgId: CUSTOMER }),
    ).rejects.toThrow(/itself/);
  });

  it('lets the customer withdraw it', async () => {
    const w = world({ customer: requested });
    await cancelDelegationRequest(w.db, { orgId: CUSTOMER, userId: USER });
    expect(w.customer()).toMatchObject({ delegationStatus: 'none', payerOrgId: null });
    await expect(cancelDelegationRequest(w.db, { orgId: CUSTOMER, userId: USER })).rejects.toThrow(
      /no request/,
    );
  });

  it('lists it for the provider with the customer name and rooms', async () => {
    const w = world({ customer: { ...requested, delegationRequestedAt: NOW } });
    const list = await requestsForProvider(w.db, PROVIDER, async () => 7);
    expect(list).toEqual([
      { orgId: CUSTOMER, orgName: 'Acme Customer', requestedAt: NOW, rooms: 7 },
    ]);
    expect(await requestsForProvider(w.db, CUSTOMER, async () => 0)).toEqual([]);
  });
});

describe('declining', () => {
  it('needs a reason, then the customer sees it and is back to paying directly', async () => {
    const w = world({ customer: requested });
    await expect(
      declineDelegation(w.db, {
        providerOrgId: PROVIDER,
        customerOrgId: CUSTOMER,
        userId: USER,
        reason: 'no',
      }),
    ).rejects.toThrow(/at least 5/);
    await declineDelegation(w.db, {
      providerOrgId: PROVIDER,
      customerOrgId: CUSTOMER,
      userId: USER,
      reason: 'We do not cover that site',
      now: NOW,
    });
    expect(w.customer()).toMatchObject({
      delegationStatus: 'none',
      payerOrgId: null,
      delegationDeclineReason: 'We do not cover that site',
    });
  });

  it('only the provider that was asked can answer', async () => {
    const w = world({ customer: requested });
    await expect(
      declineDelegation(w.db, {
        providerOrgId: '99999999-9999-4999-8999-999999999999',
        customerOrgId: CUSTOMER,
        userId: USER,
        reason: 'Not my customer',
      }),
    ).rejects.toThrow(/no longer waiting/);
  });
});

describe('accepting', () => {
  it('starts the provider subscription at once for a customer with no direct subscription', async () => {
    const w = world({ customer: requested });
    const fx = effects();
    const res = await accept(w, fx);
    expect(res.handoverAt).toBeNull();
    expect(fx.startSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        customerOrgId: CUSTOMER,
        payerOrgId: PROVIDER,
        payerCustomerId: 'cus_provider',
        priceId: 'price_p',
        quantity: 12,
        trialEnd: null,
        discount: null,
        invoiceDays: null,
      }),
    );
    expect(fx.cancelAtPeriodEnd).not.toHaveBeenCalled();
    expect(w.customer()).toMatchObject({
      billedBy: 'provider',
      delegationStatus: 'active',
      payerOrgId: PROVIDER,
      stripeSubscriptionId: 'sub_delegated',
      stripeItemId: 'si_delegated',
      plan: 'pro',
      status: 'active',
      quantity: 12,
      stripeCustomerId: 'cus_customer',
    });
  });

  it('hands over from a live direct subscription: theirs stops at its end, ours charges from then', async () => {
    const w = world({
      customer: {
        ...requested,
        plan: 'basic',
        status: 'active',
        stripeSubscriptionId: 'sub_direct',
        currentPeriodEnd: PERIOD_END,
      },
    });
    const fx = effects();
    const res = await accept(w, fx);
    expect(res.handoverAt).toEqual(PERIOD_END);
    expect(fx.startSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ trialEnd: PERIOD_END }),
    );
    expect(fx.cancelAtPeriodEnd).toHaveBeenCalledWith('sub_direct');
    // Ours is created before theirs is stopped, so there is never a gap.
    expect(fx.startSubscription.mock.invocationCallOrder[0]!).toBeLessThan(
      fx.cancelAtPeriodEnd.mock.invocationCallOrder[0]!,
    );
    expect(w.customer()).toMatchObject({
      delegationHandoverAt: PERIOD_END,
      delegationFromSubscriptionId: 'sub_direct',
      stripeSubscriptionId: 'sub_delegated',
    });
  });

  it('undoes its own subscription if the direct one cannot be stopped', async () => {
    const w = world({
      customer: {
        ...requested,
        status: 'active',
        stripeSubscriptionId: 'sub_direct',
        currentPeriodEnd: PERIOD_END,
      },
    });
    const fx = effects({
      cancelAtPeriodEnd: vi.fn(async () => {
        throw new Error('stripe down');
      }),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(accept(w, fx)).rejects.toThrow(/nothing was changed/);
    expect(fx.cancelNow).toHaveBeenCalledWith('sub_delegated');
    expect(w.customer()).toMatchObject({ billedBy: 'self', delegationStatus: 'requested' });
  });

  it('refuses when the provider has no way to pay', async () => {
    const noCard = world({ customer: requested });
    const fx = effects({ hasPaymentMethod: vi.fn(async () => false) });
    await expect(accept(noCard, fx)).rejects.toThrow(/payment method/);
    expect(fx.startSubscription).not.toHaveBeenCalled();
    const noCustomer = world({ customer: requested, provider: { stripeCustomerId: null } });
    await expect(accept(noCustomer, effects())).rejects.toThrow(/payment method/);
  });

  it('refuses when the connection or the request is gone', async () => {
    await expect(accept(world({ customer: requested, grant: null }), effects())).rejects.toThrow(
      /not connected/,
    );
    await expect(accept(world(), effects())).rejects.toThrow(/no longer waiting/);
  });

  it('bills an invoiced provider yearly by invoice, and refuses a monthly plan', async () => {
    const w = world({
      customer: requested,
      provider: { invoiceStatus: 'approved', invoiceDays: 30, stripeCustomerId: 'cus_provider' },
    });
    const fx = effects({ hasPaymentMethod: vi.fn(async () => false) });
    await expect(accept(w, fx)).rejects.toThrow(/yearly/);
    await accept(w, fx, { interval: 'year', priceId: 'price_py' });
    expect(fx.startSubscription).toHaveBeenCalledWith(expect.objectContaining({ invoiceDays: 30 }));
    expect(w.customer()).toMatchObject({ billingInterval: 'year' });
  });

  it('applies a valid code, and refuses one that is not valid', async () => {
    const w = world({ customer: requested });
    const fx = effects({
      resolveCode: vi.fn(async () => ({ promotionCodeId: 'promo_1', percentOff: 20 })),
    });
    await accept(w, fx, { code: 'PARTNER20' });
    expect(fx.startSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ discount: { promotionCodeId: 'promo_1' } }),
    );

    const bad = world({ customer: requested });
    const fx2 = effects();
    await expect(accept(bad, fx2, { code: 'NOPE' })).rejects.toThrow(/not valid/);
    expect(fx2.startSubscription).not.toHaveBeenCalled();
  });

  it('uses the standing discount, remembers its coupon, and prefers a larger code', async () => {
    const w = world({ customer: requested, provider: { providerDiscountPercent: 10 } });
    const fx = effects();
    await accept(w, fx);
    expect(fx.couponForPercent).toHaveBeenCalledWith(10, null);
    expect(fx.startSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ discount: { couponId: 'coupon_new' } }),
    );
    expect(w.provider().providerDiscountCouponId).toBe('coupon_new');

    const larger = world({ customer: requested, provider: { providerDiscountPercent: 10 } });
    const fx2 = effects({
      resolveCode: vi.fn(async () => ({ promotionCodeId: 'promo_big', percentOff: 30 })),
    });
    await accept(larger, fx2, { code: 'BIG' });
    expect(fx2.startSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ discount: { promotionCodeId: 'promo_big' } }),
    );
    expect(fx2.couponForPercent).not.toHaveBeenCalled();
  });

  it('lists the customer under the provider afterwards', async () => {
    const w = world({ customer: requested });
    await accept(w, effects());
    expect(await delegatedCustomers(w.db, PROVIDER)).toEqual([
      expect.objectContaining({
        orgId: CUSTOMER,
        orgName: 'Acme Customer',
        plan: 'pro',
        rooms: 12,
        status: 'active',
      }),
    ]);
  });
});

const active = {
  billedBy: 'provider',
  delegationStatus: 'active',
  payerOrgId: PROVIDER,
  plan: 'pro',
  status: 'active',
  stripeSubscriptionId: 'sub_delegated',
  currentPeriodEnd: PERIOD_END,
};

describe('ending', () => {
  it('stops at the period end once the provider has started charging, and warns by staying visible', async () => {
    const w = world({ customer: active });
    const fx = effects();
    expect(
      await endDelegation(w.db, fx, {
        customerOrgId: CUSTOMER,
        by: 'customer',
        userId: USER,
        now: NOW,
      }),
    ).toBe('ending');
    expect(fx.cancelAtPeriodEnd).toHaveBeenCalledWith('sub_delegated');
    expect(w.customer()).toMatchObject({
      billedBy: 'provider',
      delegationStatus: 'ending',
      delegationEndsAt: PERIOD_END,
    });
    expect(
      await endDelegation(w.db, fx, {
        customerOrgId: CUSTOMER,
        by: 'provider',
        userId: USER,
        now: NOW,
      }),
    ).toBe('already_ending');
  });

  it('before it has charged: keeps the direct subscription running and drops the provider one', async () => {
    const w = world({
      customer: {
        ...active,
        delegationHandoverAt: PERIOD_END,
        delegationFromSubscriptionId: 'sub_direct',
      },
    });
    const fx = effects();
    expect(
      await endDelegation(w.db, fx, {
        customerOrgId: CUSTOMER,
        by: 'customer',
        userId: USER,
        now: NOW,
      }),
    ).toBe('stopped');
    expect(fx.keepRunning).toHaveBeenCalledWith('sub_direct');
    expect(fx.cancelNow).toHaveBeenCalledWith('sub_delegated');
    expect(w.customer()).toMatchObject({
      billedBy: 'self',
      delegationStatus: 'none',
      payerOrgId: null,
      stripeSubscriptionId: 'sub_direct',
    });
  });

  it('withdraws a request that was never accepted, and does nothing when nothing is arranged', async () => {
    const w = world({ customer: requested });
    expect(
      await endDelegation(w.db, effects(), { customerOrgId: CUSTOMER, by: 'grant', userId: null }),
    ).toBe('request_cancelled');
    expect(w.customer()).toMatchObject({ delegationStatus: 'none', payerOrgId: null });
    expect(
      await endDelegation(w.db, effects(), { customerOrgId: CUSTOMER, by: 'grant', userId: null }),
    ).toBe('none');
  });

  it('records who ended it, and staff action in the staff audit', async () => {
    const w = world({ customer: active });
    await endDelegation(w.db, effects(), {
      customerOrgId: CUSTOMER,
      by: 'staff',
      userId: null,
      staffUserId: STAFF,
      now: NOW,
    });
    expect(w.auditLog.rows.some((r) => r.action === 'billing.delegation_ending')).toBe(true);
    expect(w.staffAudit.rows).toHaveLength(1);
  });

  it('ends when the connection ends, but only between those two organisations', async () => {
    const w = world({ customer: active });
    expect(
      await endDelegationForConnection(w.db, effects(), {
        mspOrgId: '99999999-9999-4999-8999-999999999999',
        customerOrgId: CUSTOMER,
      }),
    ).toBeNull();
    expect(
      await endDelegationForConnection(w.db, effects(), {
        mspOrgId: PROVIDER,
        customerOrgId: CUSTOMER,
        now: NOW,
      }),
    ).toBe('ending');
  });

  it('the daily sweep ends arrangements whose connection is gone, and leaves live ones', async () => {
    const live = world({ customer: active });
    expect(await endOrphanedDelegations(live.db, effects(), NOW)).toBe(0);
    expect(live.customer().delegationStatus).toBe('active');

    const gone = world({ customer: active, grant: { status: 'ended' } });
    expect(await endOrphanedDelegations(gone.db, effects(), NOW)).toBe(1);
    expect(gone.customer().delegationStatus).toBe('ending');

    const expired = world({
      customer: requested,
      grant: { endsAt: new Date('2026-10-02T00:00:00Z') },
    });
    expect(await endOrphanedDelegations(expired.db, effects(), NOW)).toBe(1);
    expect(expired.customer().delegationStatus).toBe('none');
  });
});

describe('staff discount', () => {
  it('sets, changes and clears a standing percentage, forgetting the old coupon', async () => {
    const w = world({
      provider: { providerDiscountPercent: 10, providerDiscountCouponId: 'coupon_old' },
    });
    await setProviderDiscount(w.db, { orgId: PROVIDER, staffUserId: STAFF, percent: 20 });
    expect(w.provider()).toMatchObject({
      providerDiscountPercent: 20,
      providerDiscountCouponId: null,
    });
    await setProviderDiscount(w.db, { orgId: PROVIDER, staffUserId: STAFF, percent: null });
    expect(w.provider().providerDiscountPercent).toBeNull();
    expect(w.staffAudit.rows).toHaveLength(2);
    await expect(
      setProviderDiscount(w.db, { orgId: PROVIDER, staffUserId: STAFF, percent: 150 }),
    ).rejects.toThrow(DelegationError);
  });
});

// ---- What Stripe tells us -------------------------------------------------------------------------

const sub = (over: Partial<StripeSubscriptionLike> = {}): StripeSubscriptionLike => ({
  id: 'sub_delegated',
  customer: 'cus_provider',
  status: 'active',
  metadata: { orgId: CUSTOMER, payerOrgId: PROVIDER },
  current_period_end: Math.floor(PERIOD_END.getTime() / 1000),
  items: { data: [{ id: 'si_delegated', quantity: 15, price: { id: 'price_p' } }] },
  ...over,
});

describe('Stripe events for a subscription a provider pays for', () => {
  it('update the customer organisation, never the provider, and keep the customer own Stripe customer', async () => {
    const w = world({ customer: active });
    expect(await applyStripeSubscription(w.db, sub(), PRICES, NOW)).toBe(true);
    expect(w.customer()).toMatchObject({
      quantity: 15,
      plan: 'pro',
      status: 'active',
      stripeCustomerId: 'cus_customer',
      stripeSubscriptionId: 'sub_delegated',
    });
    expect(w.provider()).toMatchObject({ plan: 'trial', status: 'none' });
    expect(w.provider().stripeSubscriptionId).toBeUndefined();
  });

  it('are refused when the organisation did not ask that provider, or the customer is not the provider one', async () => {
    const w = world({ customer: { delegationStatus: 'none', payerOrgId: null } });
    expect(await applyStripeSubscription(w.db, sub(), PRICES, NOW)).toBe(false);
    const w2 = world({ customer: active });
    expect(await applyStripeSubscription(w2.db, sub({ customer: 'cus_other' }), PRICES, NOW)).toBe(
      false,
    );
    expect(w2.customer().quantity).not.toBe(15);
  });

  it('end the arrangement when the provider subscription is cancelled', async () => {
    const w = world({ customer: { ...active, delegationStatus: 'ending' } });
    await applyStripeSubscription(w.db, sub({ status: 'canceled' }), PRICES, NOW);
    expect(w.customer()).toMatchObject({
      status: 'canceled',
      billedBy: 'self',
      delegationStatus: 'none',
      payerOrgId: null,
    });
  });

  it('do not overwrite the direct subscription that stops at the handover', async () => {
    const w = world({ customer: { ...active, delegationFromSubscriptionId: 'sub_direct' } });
    const direct = sub({
      id: 'sub_direct',
      customer: 'cus_customer',
      metadata: { orgId: CUSTOMER },
      status: 'canceled',
    });
    expect(await applyStripeSubscription(w.db, direct, PRICES, NOW)).toBe(true);
    expect(w.customer()).toMatchObject({
      stripeSubscriptionId: 'sub_delegated',
      status: 'active',
      billedBy: 'provider',
    });
  });

  it('adopt the organisation own new subscription once the provider one is ending', async () => {
    const w = world({ customer: { ...active, delegationStatus: 'ending' } });
    const own = sub({
      id: 'sub_own',
      customer: 'cus_customer',
      status: 'trialing',
      metadata: { orgId: CUSTOMER },
      items: { data: [{ id: 'si_own', quantity: 4, price: { id: 'price_b' } }] },
    });
    await applyStripeSubscription(w.db, own, PRICES, NOW);
    expect(w.customer()).toMatchObject({
      billedBy: 'self',
      stripeSubscriptionId: 'sub_own',
      plan: 'basic',
      status: 'trialing',
      delegationStatus: 'ending',
    });
    // The provider subscription ending afterwards only clears the arrangement.
    await applyStripeSubscription(w.db, sub({ status: 'canceled' }), PRICES, NOW);
    expect(w.customer()).toMatchObject({
      delegationStatus: 'none',
      payerOrgId: null,
      stripeSubscriptionId: 'sub_own',
      status: 'trialing',
    });
  });

  it('keep ordinary direct subscriptions working exactly as before', async () => {
    const w = world();
    const own = sub({ id: 'sub_own', customer: 'cus_customer', metadata: { orgId: CUSTOMER } });
    await applyStripeSubscription(w.db, own, PRICES, NOW);
    expect(w.customer()).toMatchObject({
      stripeSubscriptionId: 'sub_own',
      plan: 'pro',
      quantity: 15,
    });
  });
});

describe('invoices for a subscription a provider pays for', () => {
  it('are not recorded as the provider own open invoice', async () => {
    const w = world({ customer: active });
    const ok = await applyStripeInvoice(w.db as never, {
      id: 'in_1',
      customer: 'cus_provider',
      status: 'open',
      collection_method: 'send_invoice',
      subscription: 'sub_delegated',
    });
    expect(ok).toBe(false);
    expect(w.provider().openInvoiceId).toBeUndefined();
  });

  it('still record the provider own invoices', async () => {
    const w = world({ customer: active, provider: { stripeSubscriptionId: 'sub_provider_own' } });
    const ok = await applyStripeInvoice(w.db as never, {
      id: 'in_2',
      customer: 'cus_provider',
      status: 'open',
      collection_method: 'send_invoice',
      subscription: 'sub_provider_own',
    });
    expect(ok).toBe(true);
    expect(w.provider().openInvoiceId).toBe('in_2');
  });
});
