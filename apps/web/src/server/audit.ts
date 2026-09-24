import 'server-only';
import { db, type Prisma } from '@kestrel/db';

export async function writeAudit(args: {
  orgId: string;
  actorId: string | null;
  action: string;
  target?: string;
  meta?: Record<string, unknown>;
}) {
  await db.auditLog.create({
    data: {
      orgId: args.orgId,
      actorId: args.actorId,
      action: args.action,
      target: args.target ?? null,
      meta: (args.meta ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
