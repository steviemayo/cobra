import { z } from 'zod';
import { db } from '@kestrel/db';
import { TRIAL_DAYS } from '@kestrel/model';
import { writeAudit } from '../audit';
import { OrgBranding, readOrgBranding } from '../panel-settings';
import { setStaffAccessBlocked } from '../support-sessions';
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

  // The default look of every room's panel. Rooms follow it unless they set their own.
  getBranding: orgProcedure.input(z.object({ orgId: z.string().uuid() })).query(async ({ ctx }) => {
    const org = await db.org.findFirst({ where: { id: ctx.orgId }, select: { branding: true } });
    return readOrgBranding(org?.branding);
  }),

  setBranding: orgProcedure
    .input(z.object({ orgId: z.string().uuid(), branding: OrgBranding }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      await db.org.update({ where: { id: ctx.orgId }, data: { branding: input.branding } });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'org.branding',
        target: ctx.orgId,
        meta: { mode: input.branding.mode, language: input.branding.language },
      });
      return input.branding;
    }),

  // Whether Kestrel staff need a linked support ticket before they can open a session here.
  getStaffAccess: orgProcedure
    .input(z.object({ orgId: z.string().uuid() }))
    .query(async ({ ctx }) => {
      const org = await db.org.findFirst({
        where: { id: ctx.orgId },
        select: { staffAccessBlocked: true },
      });
      return { blocked: org?.staffAccessBlocked ?? false };
    }),

  setStaffAccess: orgProcedure
    .input(z.object({ orgId: z.string().uuid(), blocked: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      await setStaffAccessBlocked(db, {
        orgId: ctx.orgId,
        blocked: input.blocked,
        actorId: ctx.user.id,
      });
      return { blocked: input.blocked };
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
