import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { OrgRole } from '@kestrel/model';
import { createSupabaseAdmin } from '@/lib/supabase/admin';
import { writeAudit } from '../audit';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const memberId = z.string().uuid();

async function ownerCount(ctxOrgId: string) {
  return db.member.count({ where: { orgId: ctxOrgId, role: 'owner' } });
}

async function findMember(ctxOrgId: string, id: string) {
  const m = await db.member.findFirst({ where: { id, orgId: ctxOrgId } });
  if (!m) throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found' });
  return m;
}

export const memberRouter = router({
  list: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    requireRole(ctx.role, ['owner', 'dev', 'support']);
    const members = await db.member.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { createdAt: 'asc' },
    });

    // Members created before emails were stored: look them up once and persist.
    const missing = members.filter((m) => !m.email);
    if (missing.length) {
      const admin = createSupabaseAdmin();
      await Promise.all(
        missing.map(async (m) => {
          const { data } = await admin.auth.admin.getUserById(m.userId);
          const email = data.user?.email?.toLowerCase();
          if (email) {
            await db.member.update({ where: { id: m.id }, data: { email } });
            m.email = email;
          }
        }),
      );
    }

    // People a service provider added say so, and whether it is still connected.
    const providerIds = [
      ...new Set(members.flatMap((m) => (m.addedByMspOrgId ? [m.addedByMspOrgId] : []))),
    ];
    const [names, grants] = providerIds.length
      ? await Promise.all([
          db.org.findMany({ where: { id: { in: providerIds } } }),
          db.mspGrant.findMany({
            where: { customerOrgId: ctx.orgId, status: 'active', mspOrgId: { in: providerIds } },
          }),
        ])
      : [[], []];
    const nameOf = new Map(names.map((o) => [o.id, o.name]));
    const connected = new Set(
      grants.filter((g) => !g.endsAt || g.endsAt.getTime() > Date.now()).map((g) => g.mspOrgId),
    );
    return members.map((m) => ({
      id: m.id,
      userId: m.userId,
      email: m.email,
      role: m.role,
      createdAt: m.createdAt,
      isYou: m.userId === ctx.user.id,
      addedByProvider: m.addedByMspOrgId
        ? {
            name: nameOf.get(m.addedByMspOrgId) ?? 'A service provider',
            connected: connected.has(m.addedByMspOrgId),
          }
        : null,
    }));
  }),

  updateRole: orgProcedure
    .input(z.object({ orgId, memberId, role: OrgRole }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      const target = await findMember(ctx.orgId, input.memberId);
      if (target.role === 'owner' && input.role !== 'owner' && (await ownerCount(ctx.orgId)) <= 1)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'An organisation needs at least one owner',
        });
      const updated = await db.member.update({
        where: { id: target.id },
        data: { role: input.role },
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'member.role',
        target: target.id,
        meta: { email: target.email, from: target.role, to: input.role },
      });
      return { id: updated.id, role: updated.role };
    }),

  // Owners can remove anyone; anyone can remove themselves (leave).
  remove: orgProcedure.input(z.object({ orgId, memberId })).mutation(async ({ ctx, input }) => {
    const target = await findMember(ctx.orgId, input.memberId);
    const isSelf = target.userId === ctx.user.id;
    if (!isSelf) requireRole(ctx.role, ['owner']);
    if (target.role === 'owner' && (await ownerCount(ctx.orgId)) <= 1)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'An organisation needs at least one owner',
      });
    await db.member.delete({ where: { id: target.id } });
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: isSelf ? 'member.leave' : 'member.remove',
      target: target.id,
      meta: { email: target.email },
    });
    return { ok: true };
  }),
});
