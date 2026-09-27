import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { PAID_PLANS } from '@kestrel/model';
import { writeAudit } from '../audit';
import { ensureBilling, getEntitlements, priceMapFromEnv } from '../billing';
import {
  BillingNotConfigured,
  billingPortalUrl,
  startSubscription,
  stripeConfigured,
} from '../stripe';
import { orgProcedure, requireRole, router } from '../trpc';
import { billedRooms } from '../room-kinds';

const orgId = z.string().uuid();

function asTrpc(e: unknown): never {
  if (e instanceof BillingNotConfigured)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message });
  if (e instanceof TRPCError) throw e;
  console.error('[billing]', e);
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
      db.room.count({ where: { orgId: ctx.orgId, ...billedRooms } }),
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
      },
      /** False until Stripe keys and prices are configured on the server. */
      available: stripeConfigured() && !!prices.basic && !!prices.pro,
    };
  }),

  // Owners only. Sends them to Stripe Checkout, or switches plan in place if they already pay.
  subscribe: orgProcedure
    .input(z.object({ orgId, plan: z.enum(PAID_PLANS) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      try {
        const rooms = await db.room.count({ where: { orgId: ctx.orgId, ...billedRooms } });
        const res = await startSubscription(db, {
          orgId: ctx.orgId,
          plan: input.plan,
          rooms,
          email: ctx.user.email ?? null,
        });
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'billing.subscribe',
          target: ctx.orgId,
          meta: { plan: input.plan, changed: 'changed' in res },
        });
        return res;
      } catch (e) {
        return asTrpc(e);
      }
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
