import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { OrgRole } from '@kestrel/model';
import { writeAudit } from '../audit';
import { authedProcedure, orgProcedure, publicProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const INVITE_DAYS = 7;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

async function findUsable(token: string) {
  const invite = await db.invite.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { org: { select: { id: true, name: true } } },
  });
  if (!invite || invite.revokedAt || invite.acceptedAt || invite.expiresAt < new Date())
    throw new TRPCError({ code: 'NOT_FOUND', message: 'This invite is no longer valid' });
  return invite;
}

export const inviteRouter = router({
  list: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    requireRole(ctx.role, ['owner']);
    const invites = await db.invite.findMany({
      where: { orgId: ctx.orgId, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
    });
    return invites.map((i) => ({ ...i, expired: i.expiresAt < new Date() }));
  }),

  // The raw token is returned once; only its hash is stored.
  create: orgProcedure
    .input(z.object({ orgId, email: z.string().trim().toLowerCase().email(), role: OrgRole }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      if (await db.member.findFirst({ where: { orgId: ctx.orgId, email: input.email } }))
        throw new TRPCError({ code: 'CONFLICT', message: 'That person is already a member' });
      await db.invite.updateMany({
        where: { orgId: ctx.orgId, email: input.email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const token = randomBytes(24).toString('base64url');
      const invite = await db.invite.create({
        data: {
          orgId: ctx.orgId,
          email: input.email,
          role: input.role,
          tokenHash: hashToken(token),
          invitedBy: ctx.user.id,
          expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
        },
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'invite.create',
        target: invite.id,
        meta: { email: input.email, role: input.role },
      });
      return { id: invite.id, token, expiresAt: invite.expiresAt };
    }),

  revoke: orgProcedure
    .input(z.object({ orgId, inviteId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      const { count } = await db.invite.updateMany({
        where: { id: input.inviteId, orgId: ctx.orgId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'Invite not found' });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'invite.revoke',
        target: input.inviteId,
      });
      return { ok: true };
    }),

  // Shown on the accept page before sign-in. Reveals only what the token holder needs.
  preview: publicProcedure
    .input(z.object({ token: z.string().min(10).max(200) }))
    .query(async ({ input }) => {
      const invite = await findUsable(input.token);
      return { orgName: invite.org.name, email: invite.email, role: invite.role };
    }),

  accept: authedProcedure
    .input(z.object({ token: z.string().min(10).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const invite = await findUsable(input.token);
      if (ctx.user.email?.toLowerCase() !== invite.email)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `This invite is for ${invite.email}. Sign in with that address to accept it.`,
        });
      await db.$transaction([
        db.member.upsert({
          where: { orgId_userId: { orgId: invite.orgId, userId: ctx.user.id } },
          create: {
            orgId: invite.orgId,
            userId: ctx.user.id,
            email: invite.email,
            role: invite.role,
          },
          update: {},
        }),
        db.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } }),
      ]);
      await writeAudit({
        orgId: invite.orgId,
        actorId: ctx.user.id,
        action: 'invite.accept',
        target: invite.id,
        meta: { email: invite.email, role: invite.role },
      });
      return { orgId: invite.orgId };
    }),
});
