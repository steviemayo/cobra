import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { TRIAL_DAYS } from '@kestrel/model';
import { writeAudit } from '../audit';
import {
  attachTrialClaim,
  claimTrial,
  findSimilar,
  personOf,
  releaseTrialClaim,
} from '../org-signup';
import { OrgBranding, readOrgBranding } from '../panel-settings';
import { makeRateLimiter } from '../rate-limit';
import { recordAcceptance } from '../legal';
import { MFA_ROLES, MfaError, setRequireMfa } from '../customer-mfa';
import { hasVerifiedFactor } from '../customer-mfa-admin';
import { setStaffAccessBlocked } from '../support-sessions';
import { requestDeletion } from '../org-deletion';
import { authedProcedure, orgProcedure, requireRole, router } from '../trpc';

const name = z.string().trim().min(1).max(100);
// Per person, not per address: two colleagues behind the same NAT must not share an allowance.
const byUser = makeRateLimiter(10, 3_600_000);

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
      kind: m.org.kind,
      role: m.role,
    }));
  }),

  // Before creating: organisations that might already be theirs (colleagues' organisations by
  // company domain, or a similar name). Never blocks; the person decides.
  checkDuplicate: authedProcedure
    .input(z.object({ name, kind: z.enum(['customer', 'msp']) }))
    .query(({ ctx, input }) => findSimilar(db, { ...input, person: personOf(ctx.user) })),

  // Each person and company domain gets one free trial for a customer organisation. Later ones
  // start with the trial already used (control only, five rooms) and can upgrade any time. A
  // service provider has no rooms of its own, so it never uses a trial up.
  create: authedProcedure
    .input(
      z.object({
        name,
        kind: z.enum(['customer', 'msp']).default('customer'),
        // Whoever makes an organisation accepts the Terms for it (LR-5).
        acceptTerms: z.literal(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const limit = byUser(ctx.user.id);
      if (limit.ok === false)
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Try again later' });
      const person = personOf(ctx.user);
      const claimed = input.kind === 'customer' && (await claimTrial(db, person));
      const trial = input.kind === 'msp' || claimed ? 'granted' : 'used';
      const trialEndsAt = new Date(
        Date.now() + (trial === 'granted' ? TRIAL_DAYS * 86_400_000 : 0),
      );
      let org;
      try {
        org = await db.org.create({
          data: {
            name: input.name,
            kind: input.kind,
            billing: { create: { trialEndsAt } },
            members: {
              create: { userId: ctx.user.id, email: ctx.user.email?.toLowerCase(), role: 'owner' },
            },
          },
        });
      } catch (e) {
        if (claimed) await releaseTrialClaim(db, ctx.user.id);
        throw e;
      }
      if (claimed) await attachTrialClaim(db, ctx.user.id, org.id);
      await recordAcceptance(db, { userId: ctx.user.id, orgId: org.id, source: 'org_create' });
      await writeAudit({
        orgId: org.id,
        actorId: ctx.user.id,
        action: 'org.create',
        target: org.id,
        meta: { name: org.name, kind: org.kind, trial },
      });
      return { ...org, trial };
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

  // Two-step sign-in (LR-15): whether this organisation requires an authenticator app for its owners
  // and developers, and which of them have set one up.
  getSecurity: orgProcedure.input(z.object({ orgId: z.string().uuid() })).query(async ({ ctx }) => {
    const org = await db.org.findFirst({
      where: { id: ctx.orgId },
      select: { requireMfa: true },
    });
    const people = await db.member.findMany({
      where: { orgId: ctx.orgId, role: { in: [...MFA_ROLES] } },
      orderBy: { createdAt: 'asc' },
    });
    // Only owners see who has not set one up yet.
    const members =
      ctx.role === 'owner'
        ? await Promise.all(
            people.map(async (m) => ({
              userId: m.userId,
              email: m.email,
              role: m.role as string,
              enrolled: await hasVerifiedFactor(m.userId).catch(() => false),
            })),
          )
        : [];
    return { requireMfa: org?.requireMfa ?? false, members };
  }),

  setRequireMfa: orgProcedure
    .input(z.object({ orgId: z.string().uuid(), on: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      try {
        await setRequireMfa(db, {
          orgId: ctx.orgId,
          userId: ctx.user.id,
          role: ctx.role,
          on: input.on,
          actorHasFactor: await hasVerifiedFactor(ctx.user.id),
        });
        return { requireMfa: input.on };
      } catch (e) {
        if (e instanceof MfaError) throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
        throw e;
      }
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

  // An owner asks for the organisation to be deleted. Nothing is deleted: it opens a ticket for
  // Kestrel staff, who confirm it and schedule the deletion themselves.
  requestDeletion: orgProcedure
    .input(z.object({ orgId: z.string().uuid(), reason: z.string().trim().max(500).default('') }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      const res = await requestDeletion(db, {
        orgId: ctx.orgId,
        userId: ctx.user.id,
        email: ctx.user.email ?? null,
        reason: input.reason,
      });
      if (!res.alreadyRequested)
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'org.delete.request',
          target: ctx.orgId,
          meta: { ticketId: res.ticketId },
        });
      return res;
    }),
});
