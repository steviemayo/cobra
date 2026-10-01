import type { PrismaClient } from '@kestrel/db';

// Deleting an organisation (docs/decisions.md OD-1..). Only Kestrel staff (admin) can do it. It is in
// two steps so a mistake can be undone: scheduling switches the organisation off at once, and
// everything is deleted for good 30 days later by the daily clean-up, unless staff restore it first.
export type OrgDeletionDb = Pick<
  PrismaClient,
  | 'org'
  | 'gateway'
  | 'apiKey'
  | 'invite'
  | 'alertChannel'
  | 'orgBilling'
  | 'callout'
  | 'ticket'
  | 'staffAudit'
>;

export class OrgDeletionError extends Error {}

export const GRACE_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Tables that hold an organisation's data under `orgId` but have no relation to it, so deleting the
 * organisation does not remove their rows. Each is cleared by `purgeOrg`. (A test reads the Prisma
 * schema and fails if a table like this is added without being listed here or in `KEPT`.)
 */
export const PURGED_BY_ORG_ID = [
  'supportSession',
  'calendarFire',
  'roomSchedule',
  'deviceHistory',
  'usageDefinition',
  'usageSettings',
  'roomUsageDay',
  'configProfile',
  'deviceSnapshot',
  'configDeploy',
  'maintenanceWindow',
  'ticketRule',
  'itsmConnector',
  'itsmLink',
  'itsmSyncLog',
  'registerIssue',
  'pmTemplate',
  'pmSchedule',
  'pmRun',
  'registerSchedule',
] as const;

/**
 * Deliberately kept: what staff did (including this deletion), and which trials have been used (so
 * deleting an organisation is not a way to get a new trial).
 */
export const KEPT = ['staffAudit', 'trialClaim'] as const;

/** The pieces of the outside world a deletion touches, so tests can stand in for it. */
export interface DeletionEffects {
  /** Cancels the organisation's Stripe subscription at once. Best effort: a failure is reported, not fatal. */
  cancelSubscription(subscriptionId: string): Promise<void>;
}

export interface ScheduleResult {
  deleteAfter: Date;
  gatewaysReleased: number;
  subscriptionCancelled: boolean;
  /** Anything that went wrong on the way and needs a person to look. */
  warnings: string[];
}

/**
 * Switches an organisation off and sets the day it will be deleted for good.
 * - Nobody in it can use it (members and providers are refused; staff can still look).
 * - Its gateways lose their credential, so they forget it and announce themselves as unclaimed.
 * - Its subscription is cancelled, its API keys revoked, invitations removed and alert channels
 *   switched off (so nobody is paged about gateways that have just been let go).
 * Refuses while a paid callout is booked, and unless the name is typed exactly.
 */
export async function scheduleDeletion(
  db: OrgDeletionDb,
  effects: DeletionEffects,
  input: { orgId: string; staffUserId: string; confirmName: string; reason: string },
  now = new Date(),
): Promise<ScheduleResult> {
  const org = await db.org.findFirst({ where: { id: input.orgId } });
  if (!org) throw new OrgDeletionError('No such organisation');
  if (org.deletedAt)
    throw new OrgDeletionError('This organisation is already scheduled for deletion');
  if (input.confirmName.trim() !== org.name)
    throw new OrgDeletionError('Type the organisation’s name exactly to confirm');
  if (!input.reason.trim())
    throw new OrgDeletionError('Say why (it is kept in the staff audit trail)');
  const booked = await db.callout.count({
    where: { orgId: org.id, status: { in: ['booked', 'completing', 'cancelling'] } },
  });
  if (booked > 0)
    throw new OrgDeletionError(
      'It has a paid callout that is not finished. Complete or cancel it first, so nothing paid for is lost',
    );

  const warnings: string[] = [];
  let subscriptionCancelled = false;
  const billing = await db.orgBilling.findFirst({ where: { orgId: org.id } });
  if (billing?.stripeSubscriptionId && !['canceled', 'none'].includes(billing.status)) {
    try {
      await effects.cancelSubscription(billing.stripeSubscriptionId);
      subscriptionCancelled = true;
    } catch (e) {
      warnings.push(
        `The Stripe subscription could not be cancelled (${e instanceof Error ? e.message : 'unknown error'}). Cancel it in Stripe`,
      );
    }
  }
  if (billing)
    await db.orgBilling.updateMany({
      where: { orgId: org.id },
      data: { ...(subscriptionCancelled ? { status: 'canceled' } : {}), cancelAtPeriodEnd: true },
    });

  // A gateway whose credential is gone gets a 401, forgets the organisation and announces itself
  // again, so it can be claimed by someone else. A token not yet used is withdrawn too.
  const released = await db.gateway.updateMany({
    where: { orgId: org.id },
    data: { credentialHash: null, enrollTokenHash: null, enrollTokenExpiresAt: null },
  });
  await db.apiKey.updateMany({
    where: { orgId: org.id, revokedAt: null },
    data: { revokedAt: now },
  });
  await db.invite.deleteMany({ where: { orgId: org.id } });
  await db.alertChannel.updateMany({ where: { orgId: org.id }, data: { enabled: false } });

  const deleteAfter = new Date(now.getTime() + GRACE_DAYS * DAY_MS);
  await db.org.update({
    where: { id: org.id },
    data: {
      deletedAt: now,
      deleteAfter,
      deletedBy: input.staffUserId,
      deleteReason: input.reason.trim(),
    },
  });
  return { deleteAfter, gatewaysReleased: released.count, subscriptionCancelled, warnings };
}

/**
 * Takes an organisation back before it is deleted. Its people can sign in again and its data is all
 * there. What was switched off is not switched back on: gateways must be enrolled again, the
 * subscription started again, and the owner turns alert channels back on.
 */
export async function restoreOrg(
  db: Pick<OrgDeletionDb, 'org'>,
  input: { orgId: string },
  now = new Date(),
): Promise<void> {
  const org = await db.org.findFirst({ where: { id: input.orgId } });
  if (!org || !org.deletedAt)
    throw new OrgDeletionError('That organisation is not scheduled for deletion');
  if (org.deleteAfter && org.deleteAfter.getTime() <= now.getTime())
    throw new OrgDeletionError('It is past its deletion date and may already be going');
  await db.org.update({
    where: { id: org.id },
    data: { deletedAt: null, deleteAfter: null, deletedBy: null, deleteReason: null },
  });
}

type PurgeDb = Pick<PrismaClient, 'org'> &
  Record<
    (typeof PURGED_BY_ORG_ID)[number],
    { deleteMany: (a: { where: { orgId: string } }) => Promise<unknown> }
  >;

/** Deletes everything an organisation has, then the organisation (which takes the rest with it). */
export async function purgeOrg(db: PurgeDb, orgId: string): Promise<void> {
  for (const table of PURGED_BY_ORG_ID) await db[table].deleteMany({ where: { orgId } });
  await db.org.delete({ where: { id: orgId } });
}

export interface PurgeSummary {
  purged: string[];
  failed: { orgId: string; error: string }[];
}

/**
 * Deletes organisations whose day has come. Each is written to the staff audit trail first (with
 * its name), because afterwards nothing else says it existed. One organisation failing never stops
 * the others; it is tried again on the next run.
 */
export async function purgeDueOrgs(
  db: PurgeDb & Pick<OrgDeletionDb, 'staffAudit'>,
  now = new Date(),
): Promise<PurgeSummary> {
  const due = await db.org.findMany({
    where: { deletedAt: { not: null }, deleteAfter: { lte: now } },
  });
  const summary: PurgeSummary = { purged: [], failed: [] };
  for (const org of due) {
    if (!org.deletedAt || !org.deleteAfter) continue;
    try {
      await db.staffAudit.create({
        data: {
          staffUserId: org.deletedBy ?? '00000000-0000-0000-0000-000000000000',
          action: 'org.delete.purge',
          orgId: org.id,
          target: org.id,
          meta: {
            name: org.name,
            scheduledAt: org.deletedAt.toISOString(),
            reason: org.deleteReason,
          },
        },
      });
      await purgeOrg(db, org.id);
      summary.purged.push(org.id);
    } catch (e) {
      summary.failed.push({ orgId: org.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return summary;
}

/** The title of the ticket an owner's request to delete the organisation opens. */
export const DELETE_REQUEST_TITLE = 'Request to delete our organisation';

/**
 * An owner asks for the organisation to be deleted. Nothing is deleted: it opens a ticket for
 * Kestrel staff, who check it is really the owner and what should happen to the data, and then
 * schedule the deletion themselves. Asking twice returns the request already open.
 */
export async function requestDeletion(
  db: Pick<OrgDeletionDb, 'ticket'>,
  input: { orgId: string; userId: string; email: string | null; reason: string },
  now = new Date(),
): Promise<{ ticketId: string; alreadyRequested: boolean }> {
  const open = await db.ticket.findFirst({
    where: {
      orgId: input.orgId,
      title: DELETE_REQUEST_TITLE,
      status: { in: ['open', 'in_progress'] },
    },
  });
  if (open) return { ticketId: open.id, alreadyRequested: true };
  const t = await db.ticket.create({
    data: {
      orgId: input.orgId,
      title: DELETE_REQUEST_TITLE,
      body: [
        `${input.email ?? 'An owner'} asked for this organisation and all its data to be deleted.`,
        input.reason.trim() ? `Reason: ${input.reason.trim()}` : '',
        'Nothing has been deleted. Kestrel will confirm with the owner first.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      status: 'open',
      priority: 'high',
      createdBy: input.userId,
      createdByEmail: input.email,
      routedTo: 'kestrel',
      escalatedAt: now,
      escalatedBy: input.userId,
    },
  });
  return { ticketId: t.id, alreadyRequested: false };
}
