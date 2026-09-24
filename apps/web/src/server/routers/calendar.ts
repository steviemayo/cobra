import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { seal } from '@kestrel/crypto';
import { writeAudit } from '../audit';
import { CalendarCredentials, testCredentials } from '../calendar';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const name = z.string().trim().min(1).max(80);

// Calendar credentials are secrets: they are sealed on the way in and never sent back out.
export const calendarRouter = router({
  list: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const rows = await db.calendarConnection.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, provider: true, name: true, createdAt: true },
    });
    return { connections: rows, available: !!process.env.KESTREL_SECRETS_KEY };
  }),

  // Signs in once to prove the credentials work before saving them. Replaces any earlier
  // connection for the same provider.
  connect: orgProcedure
    .input(z.object({ orgId, name, credentials: CalendarCredentials }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      const key = process.env.KESTREL_SECRETS_KEY;
      if (!key)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Calendar connections aren’t set up on this Kestrel server yet',
        });
      try {
        await testCredentials(input.credentials);
      } catch (e) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Those credentials didn’t work: ${e instanceof Error ? e.message : 'sign-in failed'}`,
        });
      }
      const { provider, ...secret } = input.credentials;
      const sealed = seal(JSON.stringify(secret), key);
      const existing = await db.calendarConnection.findFirst({
        where: { orgId: ctx.orgId, provider },
      });
      if (existing)
        await db.calendarConnection.update({
          where: { id: existing.id },
          data: { name: input.name, sealed },
        });
      else
        await db.calendarConnection.create({
          data: { orgId: ctx.orgId, provider, name: input.name, sealed },
        });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'calendar.connect',
        target: ctx.orgId,
        meta: { provider, name: input.name },
      });
      return { ok: true };
    }),

  remove: orgProcedure
    .input(z.object({ orgId, connectionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      const c = await db.calendarConnection.findFirst({
        where: { id: input.connectionId, orgId: ctx.orgId },
      });
      if (!c) throw new TRPCError({ code: 'NOT_FOUND', message: 'Connection not found' });
      await db.calendarConnection.delete({ where: { id: c.id } });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'calendar.remove',
        target: ctx.orgId,
        meta: { provider: c.provider },
      });
      return { ok: true };
    }),
});
