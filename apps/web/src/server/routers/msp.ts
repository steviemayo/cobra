import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { GrantRole } from '@kestrel/model';
import {
  MspError,
  endGrant,
  grantsForCustomer,
  inviteMsp,
  managedOverview,
  mspTickets,
  pendingInvites,
  providerCode,
  respondToInvite,
} from '../msp';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();

function asTrpc(e: unknown): never {
  if (e instanceof MspError) throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
  throw e;
}

/** The organisation must be a service provider for the provider-side pages. */
async function assertProvider(id: string) {
  const org = await db.org.findFirst({ where: { id, kind: 'msp' } });
  if (!org) throw new TRPCError({ code: 'NOT_FOUND', message: 'This is not a service provider' });
  return org;
}

export const mspRouter = router({
  // ---- From a customer: who looks after us -------------------------------------------------
  providers: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    requireRole(ctx.role, ['owner']);
    return grantsForCustomer(db, ctx.orgId);
  }),

  invite: orgProcedure
    .input(
      z.object({
        orgId,
        // The provider's code: its organisation id.
        code: z.string().trim().min(10).max(60),
        role: GrantRole,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      try {
        return await inviteMsp(db, {
          customerOrgId: ctx.orgId,
          mspOrgId: input.code,
          role: input.role,
          by: { userId: ctx.user.id, email: ctx.user.email?.toLowerCase() ?? null },
        });
      } catch (e) {
        return asTrpc(e);
      }
    }),

  // End a connection, or withdraw an invitation that has not been answered.
  end: orgProcedure
    .input(z.object({ orgId, grantId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      try {
        await endGrant(db, { grantId: input.grantId, orgId: ctx.orgId, by: ctx.user.id });
        return { ok: true };
      } catch (e) {
        return asTrpc(e);
      }
    }),

  // ---- From a provider: who we look after --------------------------------------------------
  dashboard: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    await assertProvider(ctx.orgId);
    const [customers, invites] = await Promise.all([
      managedOverview(db, ctx.orgId),
      // Only owners can answer, but everyone in the provider can see there is one waiting.
      pendingInvites(db, ctx.orgId),
    ]);
    return { providerCode: providerCode(ctx.orgId), customers, invites };
  }),

  respond: orgProcedure
    .input(z.object({ orgId, grantId: z.string().uuid(), accept: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await assertProvider(ctx.orgId);
      requireRole(ctx.role, ['owner']);
      try {
        await respondToInvite(db, {
          grantId: input.grantId,
          mspOrgId: ctx.orgId,
          accept: input.accept,
          by: ctx.user.id,
        });
        return { ok: true };
      } catch (e) {
        return asTrpc(e);
      }
    }),

  endCustomer: orgProcedure
    .input(z.object({ orgId, grantId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertProvider(ctx.orgId);
      requireRole(ctx.role, ['owner']);
      try {
        await endGrant(db, { grantId: input.grantId, orgId: ctx.orgId, by: ctx.user.id });
        return { ok: true };
      } catch (e) {
        return asTrpc(e);
      }
    }),

  tickets: orgProcedure
    .input(z.object({ orgId, status: z.enum(['active', 'all']).default('active') }))
    .query(async ({ ctx, input }) => {
      await assertProvider(ctx.orgId);
      return mspTickets(db, ctx.orgId, input.status);
    }),
});
