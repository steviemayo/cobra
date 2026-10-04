import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import Stripe from 'stripe';
import { db } from '@kestrel/db';
import { BILLING_INTERVALS, PAID_PLANS } from '@kestrel/model';
import { writeAudit } from '../audit';
import {
  assertAnchorChangeAllowed,
  ensureBilling,
  getEntitlements,
  monitoredRoomIds,
  priceIdFor,
  priceMapFromEnv,
  yearlyAvailable,
} from '../billing';
import {
  DelegationError,
  acceptDelegation,
  cancelDelegationRequest,
  declineDelegation,
  delegatedCustomers,
  endDelegation,
  providerReadiness,
  requestDelegation,
  requestsForProvider,
  type DelegationDb,
} from '../delegated-billing';
import { InvoiceError, requestInvoice } from '../invoice-billing';
import { loadPlanPrices } from '../plan-prices';
import { notifyInvoiceRequest } from '../ticket-notify';
import {
  BillingNotConfigured,
  billingPortalUrl,
  delegationEffects,
  delegationEffectsOrUnavailable,
  getStripe,
  startPaymentSetup,
  startInvoiceSubscription,
  startSubscription,
  stripeConfigured,
} from '../stripe';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();

function asTrpc(e: unknown): never {
  if (e instanceof BillingNotConfigured)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message });
  if (e instanceof InvoiceError || e instanceof DelegationError)
    throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
  if (e instanceof TRPCError) throw e;
  console.error('[billing]', e);
  // Stripe's own error messages are written to be shown to a user (e.g. "No such price: ..."),
  // unlike a raw exception, so they're safe to pass through instead of a generic fallback.
  if (e instanceof Stripe.errors.StripeError) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Stripe: ${e.message}` });
  }
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Stripe could not complete that. Try again shortly',
  });
}

const effectsFor = delegationEffectsOrUnavailable;

/** While a provider pays, the organisation's own plan changes would reach the provider's subscription. */
function assertNotDelegated(b: { delegationStatus: string }, allowEnding = false): void {
  if (b.delegationStatus === 'active' || (b.delegationStatus === 'ending' && !allowEnding))
    throw new DelegationError(
      'Your provider handles billing. End that arrangement first to manage billing yourself.',
    );
}

const billingDb = db as unknown as DelegationDb;

export const billingRouter = router({
  // Any member can see the plan (the portal uses it to explain what is switched off and why).
  // Only the plan and dates are returned, never Stripe identifiers.
  status: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    const [billing, entitlements, rooms] = await Promise.all([
      ensureBilling(db, ctx.orgId),
      getEntitlements(db, ctx.orgId),
      // A room is charged once it has a monitored device; recorded-only assets are free.
      monitoredRoomIds(db, ctx.orgId).then((ids) => ids.size),
    ]);
    const prices = priceMapFromEnv();
    const now = new Date();
    // Providers that could be asked: connected and active, and only while nothing is arranged.
    const connected =
      billing.delegationStatus === 'none'
        ? (
            await db.mspGrant.findMany({ where: { customerOrgId: ctx.orgId, status: 'active' } })
          ).filter((g) => !g.endsAt || g.endsAt.getTime() > now.getTime())
        : [];
    const orgIds = [
      ...new Set([
        ...connected.map((g) => g.mspOrgId),
        ...(billing.payerOrgId ? [billing.payerOrgId] : []),
      ]),
    ];
    const orgNames = new Map(
      (orgIds.length ? await db.org.findMany({ where: { id: { in: orgIds } } }) : []).map((o) => [
        o.id,
        o.name,
      ]),
    );
    return {
      delegation: {
        status: billing.delegationStatus as 'none' | 'requested' | 'active' | 'ending',
        /** Who pays right now: the organisation itself, or a connected provider. */
        billedBy: billing.billedBy === 'provider' ? ('provider' as const) : ('self' as const),
        provider: billing.payerOrgId
          ? { id: billing.payerOrgId, name: orgNames.get(billing.payerOrgId) ?? 'Your provider' }
          : null,
        requestedAt: billing.delegationRequestedAt,
        declineReason: billing.delegationDeclineReason,
        handoverAt: billing.delegationHandoverAt,
        endsAt: billing.delegationEndsAt,
        connected: connected.map((g) => ({
          id: g.mspOrgId,
          name: orgNames.get(g.mspOrgId) ?? 'Service provider',
        })),
      },
      entitlements,
      rooms,
      subscription: {
        status: billing.status,
        quantity: billing.quantity,
        currentPeriodEnd: billing.currentPeriodEnd,
        cancelAtPeriodEnd: billing.cancelAtPeriodEnd,
        managed: !!billing.stripeCustomerId,
        trueUp: billing.trueUp,
        interval: billing.billingInterval === 'year' ? ('year' as const) : ('month' as const),
        anchorFirstOfMonth: billing.anchorFirstOfMonth,
        collectionMethod:
          billing.collectionMethod === 'send_invoice'
            ? ('send_invoice' as const)
            : ('charge_automatically' as const),
        openInvoice: billing.openInvoiceId
          ? { url: billing.openInvoiceUrl, dueAt: billing.openInvoiceDueAt }
          : null,
      },
      invoiceBilling: {
        status: billing.invoiceStatus,
        days: billing.invoiceDays,
        requestedAt: billing.invoiceRequestedAt,
        declineReason: billing.invoiceDeclineReason,
      },
      /** Whether yearly prices are set up, so the portal can offer them. */
      yearlyAvailable: yearlyAvailable(prices),
      /** False until Stripe keys and prices are configured on the server. */
      available: stripeConfigured() && !!prices.basic && !!prices.pro,
    };
  }),

  // What each plan costs per room, read from Stripe (BD-2). Any member may see it. Empty when
  // payments or prices are not set up, so the page says "price on request" instead of guessing.
  prices: orgProcedure.input(z.object({ orgId })).query(async () => {
    if (!stripeConfigured()) return [];
    return loadPlanPrices(getStripe(), priceMapFromEnv());
  }),

  // Owners only. Sends them to Stripe Checkout, or switches plan in place if they already pay.
  subscribe: orgProcedure
    .input(
      z.object({
        orgId,
        plan: z.enum(PAID_PLANS),
        interval: z.enum(BILLING_INTERVALS).default('month'),
        anchorFirstOfMonth: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      try {
        const own = await ensureBilling(db, ctx.orgId);
        // While a provider pays, this would reach the provider's subscription. Once it is ending,
        // the organisation may set up its own, charging from when the provider's stops (BD-10).
        assertNotDelegated(own, true);
        if (input.anchorFirstOfMonth) {
          try {
            assertAnchorChangeAllowed(await ensureBilling(db, ctx.orgId));
          } catch (e) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: (e as Error).message });
          }
        }
        const rooms = (await monitoredRoomIds(db, ctx.orgId)).size;
        const res = await startSubscription(db, {
          orgId: ctx.orgId,
          plan: input.plan,
          interval: input.interval,
          anchorFirstOfMonth: input.anchorFirstOfMonth,
          rooms,
          email: ctx.user.email ?? null,
          ...(own.delegationStatus === 'ending'
            ? { forceNew: true, startAt: own.delegationEndsAt }
            : {}),
        });
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'billing.subscribe',
          target: ctx.orgId,
          meta: {
            plan: input.plan,
            interval: input.interval,
            anchorFirstOfMonth: !!input.anchorFirstOfMonth,
            changed: 'changed' in res,
          },
        });
        return res;
      } catch (e) {
        return asTrpc(e);
      }
    }),

  // Owners only. Ask Kestrel staff to let the organisation pay yearly by invoice instead of card.
  requestInvoice: orgProcedure
    .input(z.object({ orgId, note: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      try {
        await requestInvoice(db, { orgId: ctx.orgId, userId: ctx.user.id, note: input.note });
        // Best effort: staff also see it in the queue, so a failed message never fails the request.
        const org = await db.org.findFirst({ where: { id: ctx.orgId } });
        await notifyInvoiceRequest({
          orgId: ctx.orgId,
          orgName: org?.name ?? 'A customer',
          note: input.note,
        }).catch(() => false);
        return { ok: true };
      } catch (e) {
        return asTrpc(e);
      }
    }),

  // Owners only, and only once staff have approved it. Starts a yearly subscription billed by invoice.
  subscribeByInvoice: orgProcedure
    .input(z.object({ orgId, plan: z.enum(PAID_PLANS) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      try {
        assertNotDelegated(await ensureBilling(db, ctx.orgId));
        const org = await db.org.findFirst({ where: { id: ctx.orgId } });
        const rooms = (await monitoredRoomIds(db, ctx.orgId)).size;
        const res = await startInvoiceSubscription(db, {
          orgId: ctx.orgId,
          orgName: org?.name ?? 'Kestrel customer',
          plan: input.plan,
          rooms,
          email: ctx.user.email ?? null,
        });
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'billing.subscribe_invoice',
          target: ctx.orgId,
          meta: { plan: input.plan },
        });
        return res;
      } catch (e) {
        return asTrpc(e);
      }
    }),

  // Owners only. Whether rooms added mid-cycle are charged pro rata straight away (true up).
  setTrueUp: orgProcedure
    .input(z.object({ orgId, enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      const billing = await ensureBilling(db, ctx.orgId);
      await db.orgBilling.update({ where: { id: billing.id }, data: { trueUp: input.enabled } });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'billing.true_up',
        target: ctx.orgId,
        meta: { enabled: input.enabled },
      });
      return { ok: true };
    }),

  portal: orgProcedure.input(z.object({ orgId })).mutation(async ({ ctx }) => {
    requireRole(ctx.role, ['owner']);
    try {
      return { url: await billingPortalUrl(db, ctx.orgId) };
    } catch (e) {
      return asTrpc(e);
    }
  }),

  // ---- Who pays: the organisation, or a connected provider (BD-5 to BD-14) --------------------------

  // Owners only. Asks a connected provider to pay. Nothing changes until the provider accepts.
  requestDelegation: orgProcedure
    .input(z.object({ orgId, providerOrgId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      try {
        await requestDelegation(billingDb, {
          orgId: ctx.orgId,
          userId: ctx.user.id,
          providerOrgId: input.providerOrgId,
        });
        return { ok: true };
      } catch (e) {
        return asTrpc(e);
      }
    }),

  cancelDelegationRequest: orgProcedure.input(z.object({ orgId })).mutation(async ({ ctx }) => {
    requireRole(ctx.role, ['owner']);
    try {
      await cancelDelegationRequest(billingDb, { orgId: ctx.orgId, userId: ctx.user.id });
      return { ok: true };
    } catch (e) {
      return asTrpc(e);
    }
  }),

  // Owners only. Stops the provider paying: at once if it has not started charging, else at the end
  // of its period.
  endDelegation: orgProcedure.input(z.object({ orgId })).mutation(async ({ ctx }) => {
    requireRole(ctx.role, ['owner']);
    try {
      const outcome = await endDelegation(billingDb, effectsFor(), {
        customerOrgId: ctx.orgId,
        by: 'customer',
        userId: ctx.user.id,
      });
      return { outcome };
    } catch (e) {
      return asTrpc(e);
    }
  }),

  // The provider's side, on its own billing page: who is waiting, who it pays for, and whether it can pay.
  delegationInbox: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    requireRole(ctx.role, ['owner']);
    const requests = await requestsForProvider(
      billingDb,
      ctx.orgId,
      async (id) => (await monitoredRoomIds(db, id)).size,
    );
    const customers = await delegatedCustomers(billingDb, ctx.orgId);
    const own = await ensureBilling(db, ctx.orgId);
    let readiness: { ok: boolean; reason?: string; invoiced?: boolean } = {
      ok: false,
      reason: 'Payments are not set up on this Kestrel server yet.',
    };
    if (stripeConfigured()) {
      const r = await providerReadiness(billingDb, delegationEffects(), ctx.orgId).catch(
        () => null,
      );
      if (r)
        readiness = r.ok ? { ok: true, invoiced: r.invoiced } : { ok: false, reason: r.reason };
    }
    return {
      requests,
      customers,
      readiness,
      discountPercent: own.providerDiscountPercent,
      yearlyAvailable: yearlyAvailable(priceMapFromEnv()),
    };
  }),

  // The provider's owner saves a card (Stripe Checkout in setup mode) so it can pay for customers.
  setupPayment: orgProcedure.input(z.object({ orgId })).mutation(async ({ ctx }) => {
    requireRole(ctx.role, ['owner']);
    try {
      const org = await db.org.findFirst({ where: { id: ctx.orgId } });
      return {
        url: await startPaymentSetup(db, {
          orgId: ctx.orgId,
          orgName: org?.name ?? 'Kestrel provider',
          email: ctx.user.email ?? null,
        }),
      };
    } catch (e) {
      return asTrpc(e);
    }
  }),

  acceptDelegation: orgProcedure
    .input(
      z.object({
        orgId,
        customerOrgId: z.string().uuid(),
        plan: z.enum(PAID_PLANS),
        interval: z.enum(BILLING_INTERVALS).default('month'),
        code: z.string().trim().max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      try {
        const priceId = priceIdFor(priceMapFromEnv(), input.plan, input.interval);
        if (!priceId) throw new BillingNotConfigured(`The ${input.interval}ly ${input.plan} plan`);
        const rooms = (await monitoredRoomIds(db, input.customerOrgId)).size;
        const res = await acceptDelegation(billingDb, effectsFor(), {
          providerOrgId: ctx.orgId,
          customerOrgId: input.customerOrgId,
          userId: ctx.user.id,
          plan: input.plan,
          interval: input.interval,
          priceId,
          rooms,
          code: input.code,
        });
        return { handoverAt: res.handoverAt };
      } catch (e) {
        return asTrpc(e);
      }
    }),

  declineDelegation: orgProcedure
    .input(z.object({ orgId, customerOrgId: z.string().uuid(), reason: z.string().max(500) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      try {
        await declineDelegation(billingDb, {
          providerOrgId: ctx.orgId,
          customerOrgId: input.customerOrgId,
          userId: ctx.user.id,
          reason: input.reason,
        });
        return { ok: true };
      } catch (e) {
        return asTrpc(e);
      }
    }),

  // The provider stops paying for one of its customers.
  endDelegationAsProvider: orgProcedure
    .input(z.object({ orgId, customerOrgId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      try {
        const b = await db.orgBilling.findFirst({ where: { orgId: input.customerOrgId } });
        if (!b || b.payerOrgId !== ctx.orgId)
          throw new DelegationError('You do not pay for that organisation.');
        const outcome = await endDelegation(billingDb, effectsFor(), {
          customerOrgId: input.customerOrgId,
          by: 'provider',
          userId: ctx.user.id,
        });
        return { outcome };
      } catch (e) {
        return asTrpc(e);
      }
    }),
});
