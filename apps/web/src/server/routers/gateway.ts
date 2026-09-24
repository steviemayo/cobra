import { z } from 'zod';
import { db } from '@kestrel/db';
import { orgProcedure, router } from '../trpc';

export const gatewayRouter = router({
  list: orgProcedure.input(z.object({ orgId: z.string().uuid() })).query(({ ctx }) =>
    db.gateway.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        status: true,
        lastSeenAt: true,
        createdAt: true,
        site: { select: { id: true, name: true } },
        _count: { select: { rooms: true } },
      },
    }),
  ),
});
