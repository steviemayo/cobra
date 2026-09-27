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
import {
  BrandError,
  BrandInput,
  getProviderBrand,
  saveProviderBrand,
  setUseBrand,
} from '../provider-brand';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();

function asTrpc(e: unknown): never {
  if (e instanceof MspError || e instanceof BrandError)
    throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
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
    const grants = await grantsForCustomer(db, ctx.orgId);
    const brands = await db.providerBrand.findMany({
      where: { mspOrgId: { in: grants.map((g) => g.mspOrgId) } },
    });
    const has = new Set(brands.map((b) => b.mspOrgId));
    return grants.map((g) => ({ ...g, hasBrand: has.has(g.mspOrgId) }));
  }),

  // Show a connected provider's name, logo and colour in this organisation's portal and on its panels.
  useBrand: orgProcedure
    .input(z.object({ orgId, grantId: z.string().uuid(), on: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      try {
        await setUseBrand(db, {
          customerOrgId: ctx.orgId,
          grantId: input.grantId,
          on: input.on,
          actorId: ctx.user.id,
        });
        return { ok: true };
      } catch (e) {
        return asTrpc(e);
      }
    }),

  // ---- From a provider: how we present ourselves ---------------------------------------------
  brand: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    await assertProvider(ctx.orgId);
    return getProviderBrand(db, ctx.orgId);
  }),

  setBrand: orgProcedure
    .input(z.object({ orgId, brand: BrandInput }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      await assertProvider(ctx.orgId);
      try {
        return await saveProviderBrand(db, {
          mspOrgId: ctx.orgId,
          input: input.brand,
          actorId: ctx.user.id,
        });
      } catch (e) {
        return asTrpc(e);
      }
    }),

  invite: orgProcedure
    .input(
      z.object({
        orgId,
        // The provider's code: its organisation id.
        code: z.string().trim().min(10).max(60),
        role: GrantRole,
        // Only these sites. Empty: the whole organisation.
        siteIds: z.array(z.string().uuid()).max(100).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      try {
        return await inviteMsp(db, {
          customerOrgId: ctx.orgId,
          mspOrgId: input.code,
          role: input.role,
          siteIds: input.siteIds,
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
