import { z } from 'zod';
import { db } from '@kestrel/db';
import { writeAudit } from '../audit';
import { exportAuditLog } from '../audit-export';
import { LONG_KEPT_PREFIXES, auditRetentionFor } from '../audit-retention';
import { viewAuditRows } from '../audit-view';
import { orgProcedure, requireRole, router } from '../trpc';

export const auditRouter = router({
  list: orgProcedure
    .input(
      z.object({ orgId: z.string().uuid(), limit: z.number().int().min(1).max(200).default(50) }),
    )
    .query(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const rows = await db.auditLog.findMany({
        where: { orgId: ctx.orgId },
        orderBy: { createdAt: 'desc' },
        take: input.limit,
      });
      return viewAuditRows(db, ctx.orgId, rows);
    }),

  // How long the log is kept. Staff can extend it; nobody else can change it.
  retention: orgProcedure.input(z.object({ orgId: z.string().uuid() })).query(async ({ ctx }) => {
    requireRole(ctx.role, ['owner', 'dev', 'support']);
    return {
      ...(await auditRetentionFor(db, ctx.orgId)),
      longKept: [...LONG_KEPT_PREFIXES] as string[],
    };
  }),

  // The whole log (or a date range) as a file, for the organisation's owner. The download is itself
  // recorded in the log.
  export: orgProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        format: z.enum(['csv', 'json']),
        from: z.date().optional(),
        to: z.date().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      const file = await exportAuditLog(db, ctx.orgId, input);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'audit.export',
        meta: { format: input.format, rows: file.count },
      });
      return file;
    }),
});
