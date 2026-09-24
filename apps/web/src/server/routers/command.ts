import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { COMMAND_TYPES } from '@kestrel/model';
import { requestCommand } from '../commands';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();

export const commandRouter = router({
  // Support and developers only. The gateway runs allowlisted commands and nothing else.
  request: orgProcedure
    .input(
      z.object({
        orgId,
        roomId: z.string().uuid(),
        type: z.enum(COMMAND_TYPES),
        deviceId: z.string().max(100).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const res = await requestCommand(db, {
        orgId: ctx.orgId,
        roomId: input.roomId,
        type: input.type,
        args: input.deviceId ? { deviceId: input.deviceId } : {},
        requestedBy: ctx.user.id,
      });
      if (!res.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: res.error });
      return { id: res.id };
    }),

  list: orgProcedure
    .input(
      z.object({
        orgId,
        roomId: z.string().uuid(),
        limit: z.number().int().min(1).max(50).default(15),
      }),
    )
    .query(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const rows = await db.remoteCommand.findMany({
        where: { orgId: ctx.orgId, roomId: input.roomId },
        orderBy: { createdAt: 'desc' },
        take: input.limit,
      });
      const users = await db.member.findMany({
        where: {
          orgId: ctx.orgId,
          userId: { in: [...new Set(rows.flatMap((r) => (r.requestedBy ? [r.requestedBy] : [])))] },
        },
        select: { userId: true, email: true },
      });
      const emailOf = new Map(users.map((u) => [u.userId, u.email]));
      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        args: (r.args ?? {}) as Record<string, string>,
        status: r.status,
        error: r.error,
        output: (r.output ?? null) as Record<string, unknown> | null,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
        requestedBy: r.requestedBy ? (emailOf.get(r.requestedBy) ?? 'Former member') : 'System',
      }));
    }),
});
