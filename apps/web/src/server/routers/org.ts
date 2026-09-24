import { z } from 'zod';
import { db } from '@kestrel/db';
import { authedProcedure, router } from '../trpc';

export const orgRouter = router({
  mine: authedProcedure.query(({ ctx }) =>
    db.org.findMany({
      where: { members: { some: { userId: ctx.user.id } } },
      orderBy: { createdAt: 'asc' },
    }),
  ),
  create: authedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(100) }))
    .mutation(({ ctx, input }) =>
      db.org.create({
        data: { name: input.name, members: { create: { userId: ctx.user.id, role: 'owner' } } },
      }),
    ),
});
