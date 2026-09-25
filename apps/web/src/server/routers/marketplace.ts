import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { writeAudit } from '../audit';
import { grantListing, publishTemplate, review } from '../marketplace';
import { recordStaffAudit } from '../staff';
import { BillingNotConfigured, startMarketplaceCheckout } from '../stripe';
import { hasStaffRole } from '@kestrel/model';
import {
  featureProcedure,
  requireRole,
  requireStaffRole,
  router,
  staffIdentityProcedure,
  staffProcedure,
} from '../trpc';

const orgId = z.string().uuid();
const listingId = z.string().uuid();
const buyProcedure = featureProcedure('marketplaceBuy');
const publishProcedure = featureProcedure('marketplacePublish');

// Listing review is Kestrel staff work (support or admin), with a second factor.
const admin = staffProcedure.use(({ ctx, next }) => {
  requireStaffRole(ctx.staff, 'support');
  return next();
});

const count = (model: unknown, key: string) => {
  const list = (model as Record<string, unknown>)?.[key];
  return Array.isArray(list) ? list.length : 0;
};

export const marketplaceRouter = router({
  // Published listings from other organisations, and whether this one already has each.
  browse: buyProcedure
    .input(z.object({ orgId, q: z.string().trim().max(80).optional() }))
    .query(async ({ ctx, input }) => {
      const listings = await db.marketplaceListing.findMany({
        where: { status: 'published' },
        orderBy: { publishedAt: 'desc' },
        take: 100,
      });
      const [orgs, owned] = await Promise.all([
        db.org.findMany({
          where: { id: { in: [...new Set(listings.map((l) => l.publisherOrgId))] } },
          select: { id: true, name: true },
        }),
        db.marketplacePurchase.findMany({
          where: { buyerOrgId: ctx.orgId },
          select: { listingId: true },
        }),
      ]);
      const publisher = new Map(orgs.map((o) => [o.id, o.name]));
      const has = new Set(owned.map((o) => o.listingId));
      const q = input.q?.toLowerCase();
      return listings
        .filter((l) => !q || `${l.name} ${l.description}`.toLowerCase().includes(q))
        .map((l) => ({
          id: l.id,
          name: l.name,
          description: l.description,
          roomType: l.roomType,
          priceCents: l.priceCents,
          currency: l.currency,
          version: l.version,
          downloads: l.downloads,
          publisher: publisher.get(l.publisherOrgId) ?? 'An organisation',
          devices: count(l.model, 'devices'),
          activities: count(l.model, 'activities'),
          owned: has.has(l.id) || l.publisherOrgId === ctx.orgId,
          mine: l.publisherOrgId === ctx.orgId,
        }));
    }),

  // Free listings arrive in your templates straight away; paid ones go through Stripe first.
  get: buyProcedure.input(z.object({ orgId, listingId })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const listing = await db.marketplaceListing.findFirst({
      where: { id: input.listingId, status: 'published' },
    });
    if (!listing)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'This listing is not available' });
    if (listing.publisherOrgId === ctx.orgId)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'That one is yours already' });
    if (listing.priceCents === 0) {
      const res = await grantListing(db, {
        listingId: listing.id,
        buyerOrgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      if (!res.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: res.error });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'marketplace.get',
        target: listing.id,
        meta: { name: listing.name, paid: false },
      });
      return { done: true as const };
    }
    const owned = await db.marketplacePurchase.findFirst({
      where: { listingId: listing.id, buyerOrgId: ctx.orgId },
    });
    if (owned) return { done: true as const };
    try {
      const url = await startMarketplaceCheckout({
        orgId: ctx.orgId,
        listing: {
          id: listing.id,
          name: listing.name,
          priceCents: listing.priceCents,
          currency: listing.currency,
        },
        email: ctx.user.email ?? null,
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'marketplace.checkout',
        target: listing.id,
        meta: { name: listing.name },
      });
      return { url };
    } catch (e) {
      if (e instanceof BillingNotConfigured)
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message });
      console.error('[marketplace]', e);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Stripe could not start that checkout',
      });
    }
  }),

  mine: publishProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    const rows = await db.marketplaceListing.findMany({
      where: { publisherOrgId: ctx.orgId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((l) => ({
      id: l.id,
      templateId: l.templateId,
      name: l.name,
      status: l.status,
      reviewNote: l.reviewNote,
      priceCents: l.priceCents,
      version: l.version,
      downloads: l.downloads,
    }));
  }),

  publish: publishProcedure
    .input(
      z.object({
        orgId,
        templateId: z.string().uuid(),
        description: z.string().trim().max(1000),
        priceCents: z.number().int().min(0).max(1_000_000),
        name: z.string().trim().min(1).max(80).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const res = await publishTemplate(db, { ...input, orgId: ctx.orgId });
      if (!res.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: res.error });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'marketplace.publish',
        target: res.id,
        meta: { updated: res.updated },
      });
      return { id: res.id };
    }),

  withdraw: publishProcedure
    .input(z.object({ orgId, listingId }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const { count: n } = await db.marketplaceListing.updateMany({
        where: {
          id: input.listingId,
          publisherOrgId: ctx.orgId,
          status: { in: ['pending', 'published'] },
        },
        data: { status: 'withdrawn' },
      });
      if (n === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'Listing not found' });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'marketplace.withdraw',
        target: input.listingId,
      });
      return { ok: true };
    }),

  // Kestrel staff only.
  isAdmin: staffIdentityProcedure.query(({ ctx }) => hasStaffRole(ctx.staff.roles, 'support')),

  pending: admin.query(async () => {
    const rows = await db.marketplaceListing.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
    const orgs = await db.org.findMany({
      where: { id: { in: rows.map((r) => r.publisherOrgId) } },
      select: { id: true, name: true },
    });
    const name = new Map(orgs.map((o) => [o.id, o.name]));
    return rows.map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
      roomType: l.roomType,
      priceCents: l.priceCents,
      version: l.version,
      publisher: name.get(l.publisherOrgId) ?? 'Unknown',
      devices: count(l.model, 'devices'),
      activities: count(l.model, 'activities'),
    }));
  }),

  review: admin
    .input(
      z.object({ listingId, approve: z.boolean(), note: z.string().trim().max(500).optional() }),
    )
    .mutation(async ({ ctx, input }) => {
      const res = await review(db, input);
      if (!res.ok)
        throw new TRPCError({ code: 'BAD_REQUEST', message: res.error ?? 'Could not review that' });
      await recordStaffAudit(db, {
        staffUserId: ctx.user.id,
        action: input.approve ? 'marketplace.approve' : 'marketplace.reject',
        target: input.listingId,
        meta: input.note ? { note: input.note } : undefined,
      });
      return { ok: true };
    }),
});
