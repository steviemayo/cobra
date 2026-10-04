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
import {
  createCustomer,
  incidentsAcrossCustomers,
  libraryPush,
  portfolio,
  providerActivity,
  setGrantEnd,
  updateCustomerMeta,
} from '../msp-portfolio';
import { writeAudit } from '../audit';
import { ProviderMemberError, setMayAddPeople } from '../provider-members';
import { endDelegationForConnection, type DelegationDb } from '../delegated-billing';
import { delegationEffectsOrUnavailable } from '../stripe';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();

/**
 * A connection has ended, so a billing arrangement between the same two organisations ends too
 * (BD-7). Best effort: the daily sweep ends anything this misses.
 */
async function endBillingFor(grant: { mspOrgId: string; customerOrgId: string } | null) {
  if (!grant) return;
  await endDelegationForConnection(
    db as unknown as DelegationDb,
    delegationEffectsOrUnavailable(),
    {
      mspOrgId: grant.mspOrgId,
      customerOrgId: grant.customerOrgId,
    },
  ).catch((e) => console.error('[billing] could not end delegation with the connection', e));
}

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

  // Let this provider's owners add people to the team (PA-2). Off until an owner turns it on.
  mayAddPeople: orgProcedure
    .input(z.object({ orgId, grantId: z.string().uuid(), on: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      try {
        await setMayAddPeople(db, {
          customerOrgId: ctx.orgId,
          grantId: input.grantId,
          userId: ctx.user.id,
          on: input.on,
        });
        return { ok: true };
      } catch (e) {
        if (e instanceof ProviderMemberError)
          throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
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
        const grant = await db.mspGrant.findFirst({ where: { id: input.grantId } });
        await endGrant(db, { grantId: input.grantId, orgId: ctx.orgId, by: ctx.user.id });
        await endBillingFor(grant);
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
        const grant = await db.mspGrant.findFirst({ where: { id: input.grantId } });
        await endGrant(db, { grantId: input.grantId, orgId: ctx.orgId, by: ctx.user.id });
        await endBillingFor(grant);
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

  // ---- Portfolio: every customer at a glance (v2) ----------------------------------------------
  portfolio: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    await assertProvider(ctx.orgId);
    const [customers, invites] = await Promise.all([
      portfolio(db, ctx.orgId),
      pendingInvites(db, ctx.orgId),
    ]);
    return { providerCode: providerCode(ctx.orgId), customers, invites };
  }),

  /** Open incidents across every customer, with the customer named. */
  incidents: orgProcedure
    .input(z.object({ orgId, includeResolved: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      await assertProvider(ctx.orgId);
      return incidentsAcrossCustomers(db, ctx.orgId, new Date(), input.includeResolved);
    }),

  /** Who looks after a customer, and labels to filter the portfolio by. */
  updateCustomer: orgProcedure
    .input(
      z.object({
        orgId,
        grantId: z.string().uuid(),
        accountManager: z.string().trim().max(80).nullable().optional(),
        tags: z.array(z.string().trim().min(1).max(30)).max(20).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertProvider(ctx.orgId);
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const res = await updateCustomerMeta(db, { ...input, mspOrgId: ctx.orgId });
      if (!res.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: res.message });
      return res.value;
    }),

  /** Sets up a customer on someone else's behalf, and invites its owner. The invitation link is returned once. */
  createCustomer: orgProcedure
    .input(
      z.object({
        orgId,
        name: z.string().trim().min(1).max(100),
        ownerEmail: z.string().trim().toLowerCase().email().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertProvider(ctx.orgId);
      requireRole(ctx.role, ['owner']);
      const res = await createCustomer(db, {
        mspOrgId: ctx.orgId,
        name: input.name,
        ownerEmail: input.ownerEmail,
        by: { userId: ctx.user.id, email: ctx.user.email?.toLowerCase() ?? null },
      });
      if (!res.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: res.message });
      return res.value;
    }),

  /** Copies one of the provider's own profiles or checklists to customers it manages. */
  pushToCustomers: orgProcedure
    .input(
      z.object({
        orgId,
        kind: z.enum(['profile', 'pm_template']),
        sourceId: z.string().uuid(),
        customerOrgIds: z.array(z.string().uuid()).min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertProvider(ctx.orgId);
      requireRole(ctx.role, ['owner', 'dev']);
      const res = await libraryPush(db, {
        mspOrgId: ctx.orgId,
        kind: input.kind,
        sourceId: input.sourceId,
        customerOrgIds: input.customerOrgIds,
        userId: ctx.user.id,
      });
      if (!res.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: res.message });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'msp.library_push',
        target: input.sourceId,
        meta: { kind: input.kind, customers: res.value.copied.length },
      });
      return res.value;
    }),

  // ---- From a customer: what our providers did, and when a connection ends -------------------
  activity: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    requireRole(ctx.role, ['owner']);
    return providerActivity(db, ctx.orgId);
  }),

  setEnd: orgProcedure
    .input(z.object({ orgId, grantId: z.string().uuid(), endsAt: z.coerce.date().nullable() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      const res = await setGrantEnd(db, {
        customerOrgId: ctx.orgId,
        grantId: input.grantId,
        endsAt: input.endsAt,
      });
      if (!res.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: res.message });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'msp.set_end',
        target: input.grantId,
        meta: { endsAt: input.endsAt?.toISOString() ?? null },
      });
      return res.value;
    }),
});
