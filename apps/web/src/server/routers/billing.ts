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
  priceMapFromEnv,
  yearlyAvailable,
} from '../billing';
import {
  BillingNotConfigured,
  billingPortalUrl,
  startSubscription,
  stripeConfigured,
} from '../stripe';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();

function asTrpc(e: unknown): never {
  if (e instanceof BillingNotConfigured)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message });
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
    return {
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
      },
      /** Whether yearly prices are set up, so the portal can offer them. */
      yearlyAvailable: yearlyAvailable(prices),
      /** False until Stripe keys and prices are configured on the server. */
      available: stripeConfigured() && !!prices.basic && !!prices.pro,
    };
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
});
