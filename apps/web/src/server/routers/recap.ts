import { z } from 'zod';
import { db } from '@kestrel/db';
import { getEntitlements } from '../billing';
import { buildRecap, recapIsEmpty, recapSince } from '../recap';
import { SITE_SCOPED } from '../site-scope';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const TEAM = ['owner', 'dev', 'support'] as const;

export const recapRouter = router({
  // Called when the portal opens and every few minutes while it is in use. It records that the
  // person is here, and when they were away long enough (and the recap is not switched off) it
  // answers with what happened meanwhile. Only the person's own membership is read or written, so a
  // provider's staff or a support session (who have none) simply get nothing.
  visit: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId }))
    .mutation(async ({ ctx }) => {
      requireRole(ctx.role, [...TEAM]);
      const member = await db.member.findUnique({
        where: { orgId_userId: { orgId: ctx.orgId, userId: ctx.user.id } },
        select: { id: true, lastSeenAt: true, recapSilenced: true },
      });
      if (!member || ctx.viewAs) return { recap: null };

      const now = new Date();
      await db.member.update({ where: { id: member.id }, data: { lastSeenAt: now } });

      const since = recapSince(member.lastSeenAt, now);
      // A site-limited view would need every figure filtered by site; it gets no recap instead.
      if (!since || member.recapSilenced || ctx.siteScope !== null) return { recap: null };

      const entitlements = await getEntitlements(db, ctx.orgId);
      const recap = await buildRecap(db, {
        orgId: ctx.orgId,
        userId: ctx.user.id,
        since,
        monitoring: Boolean(entitlements.monitoring),
        seeChanges: true,
      });
      return { recap: recapIsEmpty(recap) ? null : recap };
    }),

  // The person's own choice about the login recap.
  preference: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    const member = await db.member.findUnique({
      where: { orgId_userId: { orgId: ctx.orgId, userId: ctx.user.id } },
      select: { recapSilenced: true },
    });
    return { silenced: member?.recapSilenced ?? false, available: member !== null };
  }),

  setSilenced: orgProcedure
    .input(z.object({ orgId, silenced: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await db.member.updateMany({
        where: { orgId: ctx.orgId, userId: ctx.user.id },
        data: { recapSilenced: input.silenced },
      });
      return { silenced: input.silenced };
    }),
});
