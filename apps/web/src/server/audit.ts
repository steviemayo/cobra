import { db, type Prisma, type PrismaClient } from '@kestrel/db';

export type AuditDb = Pick<PrismaClient, 'auditLog'>;

/**
 * The one place every audit entry is written. Takes the database as an optional parameter (default
 * the real singleton) so service functions that are themselves tested with a fake database can call
 * it directly instead of keeping their own copy. `target` defaults to `orgId`: most audited actions
 * are about the organisation itself, and the few that target something more specific pass it.
 */
export async function writeAudit(
  args: {
    orgId: string;
    actorId: string | null;
    action: string;
    target?: string;
    meta?: Record<string, unknown>;
  },
  auditDb: AuditDb = db,
) {
  await auditDb.auditLog.create({
    data: {
      orgId: args.orgId,
      actorId: args.actorId,
      action: args.action,
      target: args.target ?? args.orgId,
      meta: (args.meta ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
