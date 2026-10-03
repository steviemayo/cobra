import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { writeAudit } from '../audit';
import { briefingChannelOk, sendBriefing } from '../briefing-delivery';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const TEAM = ['owner', 'dev', 'support'] as const;
const SEND_NOW_GAP_MS = 5 * 60_000;

// Site-limited provider access is not offered here (no SITE_SCOPED meta): the briefing counts the
// whole organisation or a site, and those figures are not filtered per provider.
export const briefingRouter = router({
  // What the person can sign up to, and what they already have.
  mine: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    requireRole(ctx.role, [...TEAM]);
    const [channels, sites, subs] = await Promise.all([
      db.alertChannel.findMany({
        where: { orgId: ctx.orgId, enabled: true },
        select: { id: true, name: true, type: true },
        orderBy: { name: 'asc' },
      }),
      db.site.findMany({
        where: { orgId: ctx.orgId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      db.briefingSubscription.findMany({
        where: { orgId: ctx.orgId, userId: ctx.user.id },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return {
      channels: channels.filter((c) => briefingChannelOk(c.type)),
      sites,
      subscriptions: subs.map((s) => ({
        id: s.id,
        channelId: s.channelId,
        siteId: s.siteId,
        lastSentAt: s.lastSentAt,
      })),
    };
  }),

  subscribe: orgProcedure
    .input(z.object({ orgId, channelId: z.string().uuid(), siteId: z.string().uuid().nullable() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      const channel = await db.alertChannel.findFirst({
        where: { id: input.channelId, orgId: ctx.orgId, enabled: true },
      });
      if (!channel || !briefingChannelOk(channel.type))
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'That channel cannot carry a briefing',
        });
      if (input.siteId) {
        const site = await db.site.findFirst({ where: { id: input.siteId, orgId: ctx.orgId } });
        if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'Site not found' });
      }
      // The unique index treats a missing site as distinct each time, so check for it here.
      const existing = await db.briefingSubscription.findFirst({
        where: {
          orgId: ctx.orgId,
          userId: ctx.user.id,
          channelId: input.channelId,
          siteId: input.siteId,
        },
      });
      if (existing) return { id: existing.id };
      const sub = await db.briefingSubscription.create({
        data: {
          orgId: ctx.orgId,
          userId: ctx.user.id,
          channelId: input.channelId,
          siteId: input.siteId,
        },
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'briefing.subscribe',
        target: sub.id,
        meta: { channel: channel.name, siteId: input.siteId },
      });
      return { id: sub.id };
    }),

  unsubscribe: orgProcedure
    .input(z.object({ orgId, id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      // Only your own sign-ups.
      await db.briefingSubscription.deleteMany({
        where: { id: input.id, orgId: ctx.orgId, userId: ctx.user.id },
      });
      return { ok: true };
    }),

  // Sends one right away so the person can see what they will get.
  sendNow: orgProcedure
    .input(z.object({ orgId, id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      const sub = await db.briefingSubscription.findFirst({
        where: { id: input.id, orgId: ctx.orgId, userId: ctx.user.id },
        include: { channel: true },
      });
      if (!sub) throw new TRPCError({ code: 'NOT_FOUND', message: 'Sign-up not found' });
      const now = new Date();
      if (sub.lastSentAt && now.getTime() - sub.lastSentAt.getTime() < SEND_NOW_GAP_MS)
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'A briefing was sent a moment ago. Try again in a few minutes.',
        });
      return sendBriefing(db, sub, now);
    }),
});
