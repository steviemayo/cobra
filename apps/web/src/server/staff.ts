import type { Prisma, PrismaClient } from '@kestrel/db';
import { effectiveStatus } from './gateway-status';
import { isBilledRoom } from './room-kinds';

// Kestrel staff: the people who can use /staff, and what the staff portal shows about every
// organisation. Deliberately not scoped to one org. Functions take the database as a parameter so
// they can be tested without one.
export type StaffDb = Pick<
  PrismaClient,
  | 'staffUser'
  | 'staffAudit'
  | 'org'
  | 'orgBilling'
  | 'member'
  | 'site'
  | 'room'
  | 'gateway'
  | 'incident'
  | 'ticket'
  | 'auditLog'
>;

export interface StaffIdentity {
  id: string;
  userId: string;
  email: string | null;
  roles: string[];
}

export async function findStaff(db: StaffDb, userId: string): Promise<StaffIdentity | null> {
  const row = await db.staffUser.findFirst({ where: { userId } });
  return row ? { id: row.id, userId: row.userId, email: row.email, roles: row.roles } : null;
}

/**
 * Staff sign in with a second factor. On unless STAFF_REQUIRE_MFA is exactly "false" (local
 * development), so leaving the variable out is the safe choice.
 */
export function mfaRequired(env: string | undefined = process.env.STAFF_REQUIRE_MFA): boolean {
  return env !== 'false';
}

export async function recordStaffAudit(
  db: StaffDb,
  entry: {
    staffUserId: string;
    action: string;
    orgId?: string;
    target?: string;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  await db.staffAudit.create({
    data: {
      staffUserId: entry.staffUserId,
      action: entry.action,
      orgId: entry.orgId ?? null,
      target: entry.target ?? null,
      meta: (entry.meta ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

export interface OrgSummary {
  id: string;
  name: string;
  createdAt: Date;
  members: number;
  /** The organisation requires a linked ticket before staff can open a session. */
  staffAccessBlocked: boolean;
  /** Set when it is scheduled for deletion: when it was switched off, when it goes for good, and why. */
  deletedAt: Date | null;
  deleteAfter: Date | null;
  deleteReason: string | null;
  /** trial, basic, pro, or "none" if the org has no billing record yet. */
  plan: string;
  billingStatus: string;
  trialEndsAt: Date | null;
  /** Whole days left in the trial, or null when the plan is not a trial. Negative once it has ended. */
  trialDaysLeft: number | null;
  /** Ordinary rooms, which are the ones billed. */
  rooms: number;
  combinedRooms: number;
  gateways: number;
  gatewaysOnline: number;
  openIncidents: number;
  openTickets: number;
  lastActivity: Date | null;
}

const DAY = 86_400_000;

/** One row per organisation, for the staff directory. Counts only: no customer content. */
export async function orgDirectory(db: StaffDb, now = new Date()): Promise<OrgSummary[]> {
  const orgs = await db.org.findMany({ orderBy: { createdAt: 'asc' } });
  const [billing, members, rooms, gateways, incidents, tickets] = await Promise.all([
    db.orgBilling.findMany({}),
    db.member.findMany({}),
    db.room.findMany({}),
    db.gateway.findMany({}),
    db.incident.findMany({ where: { status: 'open', parentId: null } }),
    db.ticket.findMany({ where: { status: 'open' } }),
  ]);
  const by = <T extends { orgId: string }>(rows: T[]) => {
    const map = new Map<string, T[]>();
    for (const r of rows) map.set(r.orgId, [...(map.get(r.orgId) ?? []), r]);
    return map;
  };
  const b = new Map(billing.map((x) => [x.orgId, x]));
  const m = by(members);
  const r = by(rooms);
  const g = by(gateways);
  const i = by(incidents);
  const t = by(tickets);

  return Promise.all(
    orgs.map(async (o) => {
      const bill = b.get(o.id);
      const orgRooms = r.get(o.id) ?? [];
      const orgGateways = g.get(o.id) ?? [];
      const trial = bill?.plan === 'trial';
      const last = await db.auditLog.findMany({
        where: { orgId: o.id },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      return {
        id: o.id,
        name: o.name,
        createdAt: o.createdAt,
        members: (m.get(o.id) ?? []).length,
        staffAccessBlocked: !!o.staffAccessBlocked,
        deletedAt: o.deletedAt ?? null,
        deleteAfter: o.deleteAfter ?? null,
        deleteReason: o.deleteReason ?? null,
        plan: bill?.plan ?? 'none',
        billingStatus: bill?.status ?? 'none',
        trialEndsAt: bill?.trialEndsAt ?? null,
        trialDaysLeft: trial
          ? Math.ceil((bill!.trialEndsAt.getTime() - now.getTime()) / DAY)
          : null,
        rooms: orgRooms.filter(isBilledRoom).length,
        combinedRooms: orgRooms.filter((x) => x.kind === 'combined').length,
        gateways: orgGateways.length,
        gatewaysOnline: orgGateways.filter((x) => effectiveStatus(x, now.getTime()) === 'online')
          .length,
        openIncidents: (i.get(o.id) ?? []).length,
        openTickets: (t.get(o.id) ?? []).length,
        lastActivity: last[0]?.createdAt ?? null,
      };
    }),
  );
}

export interface OrgDetail extends OrgSummary {
  sites: { id: string; name: string; rooms: number }[];
  team: { userId: string; email: string | null; role: string }[];
  recentActivity: { id: string; action: string; target: string | null; createdAt: Date }[];
  staffActivity: { id: string; action: string; createdAt: Date; staffUserId: string }[];
}

/** Everything the staff org page shows. Members are listed by email and role only. */
export async function orgDetail(
  db: StaffDb,
  orgId: string,
  now = new Date(),
): Promise<OrgDetail | null> {
  const summary = (await orgDirectory(db, now)).find((o) => o.id === orgId);
  if (!summary) return null;
  const [sites, rooms, members, activity, staffActivity] = await Promise.all([
    db.site.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } }),
    db.room.findMany({ where: { orgId } }),
    db.member.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } }),
    db.auditLog.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 25 }),
    db.staffAudit.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 25 }),
  ]);
  return {
    ...summary,
    sites: sites.map((s) => ({
      id: s.id,
      name: s.name,
      rooms: rooms.filter((r) => r.siteId === s.id && isBilledRoom(r)).length,
    })),
    team: members.map((x) => ({ userId: x.userId, email: x.email, role: x.role })),
    recentActivity: activity.map((a) => ({
      id: a.id,
      action: a.action,
      target: a.target,
      createdAt: a.createdAt,
    })),
    staffActivity: staffActivity.map((a) => ({
      id: a.id,
      action: a.action,
      createdAt: a.createdAt,
      staffUserId: a.staffUserId,
    })),
  };
}
