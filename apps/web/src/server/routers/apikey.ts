import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { ApiKeyError, createApiKey, listApiKeys, revokeApiKey } from '../api-keys';
import { writeAudit } from '../audit';
import { featureProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
// The API comes with monitoring, so keys can be made only on plans that have it.
const apiProcedure = featureProcedure('monitoring');

export const apikeyRouter = router({
  list: apiProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    requireRole(ctx.role, ['owner']);
    return listApiKeys(db, ctx.orgId);
  }),

  // The key itself comes back once, here, and is never shown again.
  create: apiProcedure
    .input(
      z.object({
        orgId,
        name: z.string().trim().min(1).max(80),
        expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      try {
        const made = await createApiKey(db, {
          orgId: ctx.orgId,
          name: input.name,
          userId: ctx.user.id,
          expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
        });
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'apikey.create',
          target: made.id,
          meta: { name: input.name, prefix: made.prefix },
        });
        return made;
      } catch (e) {
        if (e instanceof ApiKeyError) throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
        throw e;
      }
    }),

  revoke: apiProcedure
    .input(z.object({ orgId, keyId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      if (!(await revokeApiKey(db, ctx.orgId, input.keyId)))
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Key not found' });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'apikey.revoke',
        target: input.keyId,
      });
      return { ok: true };
    }),
});
