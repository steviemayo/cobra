import { z } from 'zod';
import { db } from '@kestrel/db';
import { TRIAL_DAYS } from '@kestrel/model';
import { writeAudit } from '../audit';
import { authedProcedure, orgProcedure, requireRole, router } from '../trpc';

const name = z.string().trim().min(1).max(100);

export const orgRouter = router({
  // Every org the user belongs to, with their role in each.
  mine: authedProcedure.query(async ({ ctx }) => {
    const memberships = await db.member.findMany({
      where: { userId: ctx.user.id },
      include: { org: true },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => ({
      id: m.org.id,
      name: m.org.name,
      createdAt: m.org.createdAt,
      role: m.role,
    }));
  }),

  create: authedProcedure.input(z.object({ name })).mutation(async ({ ctx, input }) => {
    const org = await db.org.create({
      data: {
        name: input.name,
        billing: { create: { trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86_400_000) } },
        members: {
          create: { userId: ctx.user.id, email: ctx.user.email?.toLowerCase(), role: 'owner' },
        },
      },
    });
    await writeAudit({
      orgId: org.id,
      actorId: ctx.user.id,
      action: 'org.create',
      target: org.id,
      meta: { name: org.name },
    });
    return org;
  }),

  rename: orgProcedure
    .input(z.object({ orgId: z.string().uuid(), name }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      const org = await db.org.update({ where: { id: ctx.orgId }, data: { name: input.name } });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'org.rename',
        target: ctx.orgId,
        meta: { name: org.name },
      });
      return org;
    }),
});
