import type { PrismaClient } from '@kestrel/db';
import {
  bestMspRole,
  effectiveMspRole,
  grantTakesTickets,
  lowestMspRole,
  mspRoute,
  type GrantRole,
  type OrgRole,
  type TicketSla,
} from '@kestrel/model';
import { writeAudit } from './audit';
import { effectiveStatus } from './gateway-status';
import { clearStaleAssignees } from './ticket-assignees';
import { slaForTicket, slaUrgency } from './tickets';
import { isBilledRoom } from './room-kinds';

// Managed service providers. An MSP is an organisation of kind "msp"; a customer's owner invites
// it, the MSP's owner accepts, and either side can end it. While it is active, the MSP's people
// work inside the customer at the lower of their own role and the grant's role (never owner).
// Functions take the database as a parameter so they can be tested without one.
export type MspDb = Pick<
  PrismaClient,
  | 'org'
  | 'member'
  | 'mspGrant'
  | 'auditLog'
  | 'ticket'
  | 'ticketComment'
  | 'room'
  | 'gateway'
  | 'incident'
  | 'site'
>;

export class MspError extends Error {}

const LIVE = ['pending', 'active'];

/** A short code the provider gives customers so they can invite it: its organisation id. */
export const providerCode = (mspOrgId: string) => mspOrgId;

/** A customer's owner invites a provider. The provider still has to accept. */
export async function inviteMsp(
  db: MspDb,
  args: {
    customerOrgId: string;
    mspOrgId: string;
    role: GrantRole;
    /** Only these sites. Empty or missing: the whole organisation. */
    siteIds?: string[];
    by: { userId: string; email: string | null };
  },
): Promise<{ id: string }> {
  const code = args.mspOrgId.trim().toLowerCase();
  const msp = await db.org.findFirst({ where: { id: code, kind: 'msp' } });
  if (!msp) throw new MspError('No service provider has that code. Check it with them.');
  const customer = await db.org.findFirst({ where: { id: args.customerOrgId } });
  if (!customer || customer.kind === 'msp')
    throw new MspError('Only a customer organisation can invite a service provider.');
  if (msp.id === customer.id) throw new MspError('An organisation cannot manage itself.');
  const siteIds = [...new Set(args.siteIds ?? [])];
  if (siteIds.length > 0) {
    const found = await db.site.findMany({ where: { orgId: customer.id, id: { in: siteIds } } });
    if (found.length !== siteIds.length)
      throw new MspError('One of those sites is not part of this organisation.');
  }
  const existing = await db.mspGrant.findFirst({
    where: { mspOrgId: msp.id, customerOrgId: customer.id, status: { in: LIVE } },
  });
  if (existing)
    throw new MspError(
      existing.status === 'active'
        ? `${msp.name} already looks after this organisation.`
        : `${msp.name} has already been invited and has not answered yet.`,
    );
  const grant = await db.mspGrant.create({
    data: {
      mspOrgId: msp.id,
      customerOrgId: customer.id,
      role: args.role,
      siteIds,
      status: 'pending',
      invitedBy: args.by.userId,
      invitedByEmail: args.by.email,
    },
  });
  await writeAudit(
    {
      orgId: customer.id,
      actorId: args.by.userId,
      action: 'msp.invite',
      meta: { msp: msp.name, role: args.role },
    },
    db,
  );
  await writeAudit(
    {
      orgId: msp.id,
      actorId: null,
      action: 'msp.invited',
      meta: { customer: customer.name, role: args.role },
    },
    db,
  );
  return { id: grant.id };
}

/** The provider's owner answers an invitation. */
export async function respondToInvite(
  db: MspDb,
  args: { grantId: string; mspOrgId: string; accept: boolean; by: string; now?: Date },
): Promise<void> {
  const now = args.now ?? new Date();
  const g = await db.mspGrant.findFirst({
    where: { id: args.grantId, mspOrgId: args.mspOrgId, status: 'pending' },
  });
  if (!g) throw new MspError('That invitation is no longer waiting.');
  await db.mspGrant.update({
    where: { id: g.id },
    data: {
      status: args.accept ? 'active' : 'declined',
      respondedBy: args.by,
      respondedAt: now,
    },
  });
  const [msp, customer] = await Promise.all([
    db.org.findFirst({ where: { id: g.mspOrgId } }),
    db.org.findFirst({ where: { id: g.customerOrgId } }),
  ]);
  const action = args.accept ? 'msp.accepted' : 'msp.declined';
  await writeAudit({ orgId: g.customerOrgId, actorId: null, action, meta: { msp: msp?.name } }, db);
  await writeAudit(
    { orgId: g.mspOrgId, actorId: args.by, action, meta: { customer: customer?.name } },
    db,
  );
}

/** Either side ends the relationship (or the customer withdraws a pending invitation). */
export async function endGrant(
  db: MspDb,
  args: { grantId: string; orgId: string; by: string; now?: Date },
): Promise<void> {
  const now = args.now ?? new Date();
  const g = await db.mspGrant.findFirst({
    where: { id: args.grantId, status: { in: LIVE } },
  });
  // Only a party to the grant may end it.
  if (!g || (g.customerOrgId !== args.orgId && g.mspOrgId !== args.orgId))
    throw new MspError('That connection was not found.');
  await db.mspGrant.update({
    where: { id: g.id },
    data: { status: 'ended', endedAt: now, endedBy: args.by },
  });
  // Tickets that were with the provider go back to the organisation's own team.
  await db.ticket.updateMany({
    where: { orgId: g.customerOrgId, routedTo: mspRoute(g.mspOrgId) },
    data: { routedTo: 'org' },
  });
  // Provider staff can no longer be assigned tickets here.
  await clearStaleAssignees(db, g.customerOrgId);
  const [msp, customer] = await Promise.all([
    db.org.findFirst({ where: { id: g.mspOrgId } }),
    db.org.findFirst({ where: { id: g.customerOrgId } }),
  ]);
  const byCustomer = args.orgId === g.customerOrgId;
  await writeAudit(
    {
      orgId: g.customerOrgId,
      actorId: byCustomer ? args.by : null,
      action: 'msp.ended',
      meta: { msp: msp?.name, by: byCustomer ? 'you' : 'the service provider' },
    },
    db,
  );
  await writeAudit(
    {
      orgId: g.mspOrgId,
      actorId: byCustomer ? null : args.by,
      action: 'msp.ended',
      meta: { customer: customer?.name, by: byCustomer ? 'the customer' : 'you' },
    },
    db,
  );
}

export interface CustomerGrantView {
  id: string;
  mspOrgId: string;
  mspName: string;
  role: string;
  status: string;
  /** Names of the sites it is limited to. Empty: the whole organisation. */
  siteNames: string[];
  /** The owner chose to show this provider's name, logo and colour. */
  useBrand: boolean;
  createdAt: Date;
  endsAt: Date | null;
}

/** The providers a customer has invited or works with. */
export async function grantsForCustomer(
  db: MspDb,
  customerOrgId: string,
): Promise<CustomerGrantView[]> {
  const grants = await db.mspGrant.findMany({
    where: { customerOrgId, status: { in: LIVE } },
    orderBy: { createdAt: 'asc' },
  });
  const orgs = await db.org.findMany({ where: { id: { in: grants.map((g) => g.mspOrgId) } } });
  const name = new Map(orgs.map((o) => [o.id, o.name]));
  const sites = await db.site.findMany({ where: { orgId: customerOrgId } });
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  return grants.map((g) => ({
    id: g.id,
    mspOrgId: g.mspOrgId,
    mspName: name.get(g.mspOrgId) ?? 'Unknown provider',
    role: g.role,
    status: g.status,
    siteNames: g.siteIds.map((id) => siteName.get(id) ?? 'Unknown site'),
    useBrand: !!g.useBrand,
    endsAt: g.endsAt,
    createdAt: g.createdAt,
  }));
}

export interface MspInviteView {
  id: string;
  customerName: string;
  role: string;
  /** Number of sites it is limited to. 0: the whole organisation. */
  siteCount: number;
  invitedByEmail: string | null;
  createdAt: Date;
}

/** Invitations waiting for the provider's owner. */
export async function pendingInvites(db: MspDb, mspOrgId: string): Promise<MspInviteView[]> {
  const grants = await db.mspGrant.findMany({
    where: { mspOrgId, status: 'pending' },
    orderBy: { createdAt: 'asc' },
  });
  const orgs = await db.org.findMany({ where: { id: { in: grants.map((g) => g.customerOrgId) } } });
  const name = new Map(orgs.map((o) => [o.id, o.name]));
  return grants.map((g) => ({
    id: g.id,
    customerName: name.get(g.customerOrgId) ?? 'Unknown organisation',
    role: g.role,
    siteCount: g.siteIds.length,
    invitedByEmail: g.invitedByEmail,
    createdAt: g.createdAt,
  }));
}

// ---- Access ---------------------------------------------------------------------------------

export interface MspAccess {
  role: OrgRole;
  mspOrgId: string;
  mspName: string;
  /** null: the whole organisation. A list: only these sites. */
  sites: string[] | null;
}

type Candidate = { memberRole: OrgRole; grant: GrantRole; mspOrgId: string; siteIds: string[] };

/**
 * The role and scope a person gets in a customer from the provider grants they can use.
 *
 * A whole-organisation grant wins: the best role among those, no site limit. With only
 * site-limited grants, the sites are combined and the role is the LOWEST of them (the cautious
 * choice, since one role cannot be given per site).
 */
function resolve(
  candidates: Candidate[],
): { role: OrgRole; from: Candidate; sites: string[] | null } | null {
  if (candidates.length === 0) return null;
  const whole = candidates.filter((c) => c.siteIds.length === 0);
  if (whole.length > 0) {
    const role = bestMspRole(whole);
    const from = role && whole.find((c) => effectiveMspRole(c.memberRole, c.grant) === role);
    return role && from ? { role, from, sites: null } : null;
  }
  const role = lowestMspRole(candidates);
  const from = role && candidates.find((c) => effectiveMspRole(c.memberRole, c.grant) === role);
  return role && from
    ? { role, from, sites: [...new Set(candidates.flatMap((c) => c.siteIds))] }
    : null;
}

/**
 * What this person may do inside `customerOrgId` because of a service provider they belong to, or
 * null. Only active grants count.
 */
export async function mspAccess(
  db: MspDb,
  userId: string,
  customerOrgId: string,
): Promise<MspAccess | null> {
  const memberships = await db.member.findMany({ where: { userId } });
  if (memberships.length === 0) return null;
  const grants = await db.mspGrant.findMany({
    where: {
      customerOrgId,
      status: 'active',
      mspOrgId: { in: memberships.map((m) => m.orgId) },
    },
  });
  const roleIn = new Map(memberships.map((m) => [m.orgId, m.role as OrgRole]));
  const now = Date.now();
  const found = resolve(
    // A connection past its end date no longer counts, even before the daily clean-up ends it.
    grants
      .filter((g) => !g.endsAt || g.endsAt.getTime() > now)
      .map((g) => ({
        memberRole: roleIn.get(g.mspOrgId)!,
        grant: g.role as GrantRole,
        mspOrgId: g.mspOrgId,
        siteIds: g.siteIds,
      })),
  );
  if (!found) return null;
  // Name the provider that gave the role, for the banner and the activity log.
  const msp = await db.org.findFirst({ where: { id: found.from.mspOrgId } });
  return {
    role: found.role,
    mspOrgId: found.from.mspOrgId,
    mspName: msp?.name ?? 'Service provider',
    sites: found.sites,
  };
}

export interface ManagedCustomer {
  orgId: string;
  name: string;
  role: OrgRole;
  mspOrgId: string;
  mspName: string;
  /** null: the whole organisation. A list: only these sites. */
  sites: string[] | null;
}

/** Every customer this person can work in through a provider, for the organisation switcher. */
export async function managedCustomers(db: MspDb, userId: string): Promise<ManagedCustomer[]> {
  const memberships = await db.member.findMany({ where: { userId } });
  if (memberships.length === 0) return [];
  const grants = await db.mspGrant.findMany({
    where: { status: 'active', mspOrgId: { in: memberships.map((m) => m.orgId) } },
  });
  const customerIds = [...new Set(grants.map((g) => g.customerOrgId))];
  const [customers, providers] = await Promise.all([
    db.org.findMany({ where: { id: { in: customerIds } } }),
    db.org.findMany({ where: { id: { in: [...new Set(grants.map((g) => g.mspOrgId))] } } }),
  ]);
  const roleIn = new Map(memberships.map((m) => [m.orgId, m.role as OrgRole]));
  const mspName = new Map(providers.map((o) => [o.id, o.name]));
  return customers
    .map((c) => {
      const found = resolve(
        grants
          .filter((g) => g.customerOrgId === c.id)
          .map((g) => ({
            memberRole: roleIn.get(g.mspOrgId)!,
            grant: g.role as GrantRole,
            mspOrgId: g.mspOrgId,
            siteIds: g.siteIds,
          })),
      );
      return found
        ? {
            orgId: c.id,
            name: c.name,
            role: found.role,
            mspOrgId: found.from.mspOrgId,
            mspName: mspName.get(found.from.mspOrgId) ?? 'Service provider',
            sites: found.sites,
          }
        : null;
    })
    .filter((x): x is ManagedCustomer => x !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Where a new ticket goes: to a service provider that takes tickets and covers it, otherwise to the
 * customer's own team. For a ticket about a room, a provider limited to that room's site is the
 * most specific match and wins; otherwise the oldest whole-organisation connection.
 */
export async function routeForNewTicket(
  db: MspDb,
  customerOrgId: string,
  roomId?: string | null,
): Promise<string> {
  const grants = (
    await db.mspGrant.findMany({
      where: { customerOrgId, status: 'active' },
      orderBy: { createdAt: 'asc' },
    })
  ).filter((g) => grantTakesTickets(g.role as GrantRole));
  const room = roomId
    ? await db.room.findFirst({ where: { id: roomId, orgId: customerOrgId } })
    : null;
  const specific = room ? grants.find((g) => g.siteIds.includes(room.siteId)) : undefined;
  const whole = grants.find((g) => g.siteIds.length === 0);
  const chosen = specific ?? whole;
  return chosen ? mspRoute(chosen.mspOrgId) : 'org';
}

// ---- The provider's own view -----------------------------------------------------------------

export interface ManagedRow {
  grantId: string;
  orgId: string;
  name: string;
  role: string;
  /** Number of sites the connection is limited to. 0: the whole organisation. */
  limitedToSites: number;
  rooms: number;
  gateways: number;
  gatewaysOnline: number;
  openIncidents: number;
  /** Open tickets currently with this provider. */
  ticketsWithUs: number;
}

/** The provider's customers with the numbers they need at a glance. */
export async function managedOverview(
  db: MspDb,
  mspOrgId: string,
  now = new Date(),
): Promise<ManagedRow[]> {
  const grants = await db.mspGrant.findMany({
    where: { mspOrgId, status: 'active' },
    orderBy: { createdAt: 'asc' },
  });
  const ids = grants.map((g) => g.customerOrgId);
  if (ids.length === 0) return [];
  const [orgs, rooms, gateways, incidents, tickets] = await Promise.all([
    db.org.findMany({ where: { id: { in: ids } } }),
    db.room.findMany({ where: { orgId: { in: ids } } }),
    db.gateway.findMany({ where: { orgId: { in: ids } } }),
    db.incident.findMany({ where: { orgId: { in: ids }, status: 'open' } }),
    db.ticket.findMany({
      where: {
        orgId: { in: ids },
        routedTo: mspRoute(mspOrgId),
        status: { in: ['open', 'in_progress'] },
      },
    }),
  ]);
  const name = new Map(orgs.map((o) => [o.id, o.name]));
  return grants
    .map((g): ManagedRow => {
      const covers = (siteId: string) => g.siteIds.length === 0 || g.siteIds.includes(siteId);
      const ownRooms = rooms.filter((r) => r.orgId === g.customerOrgId && covers(r.siteId));
      const gw = gateways.filter((x) => x.orgId === g.customerOrgId && covers(x.siteId));
      const roomIds = new Set(ownRooms.map((r) => r.id));
      const gwIds = new Set(gw.map((x) => x.id));
      return {
        grantId: g.id,
        orgId: g.customerOrgId,
        name: name.get(g.customerOrgId) ?? 'Unknown organisation',
        role: g.role,
        limitedToSites: g.siteIds.length,
        rooms: ownRooms.filter(isBilledRoom).length,
        gateways: gw.length,
        gatewaysOnline: gw.filter((x) => effectiveStatus(x, now.getTime()) === 'online').length,
        openIncidents: incidents.filter(
          (i) =>
            i.orgId === g.customerOrgId &&
            (i.roomId ? roomIds.has(i.roomId) : i.gatewayId !== null && gwIds.has(i.gatewayId)),
        ).length,
        ticketsWithUs: tickets.filter((t) => t.orgId === g.customerOrgId).length,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface MspTicketRow {
  id: string;
  orgId: string;
  orgName: string;
  title: string;
  status: string;
  priority: string;
  createdAt: Date;
  updatedAt: Date;
  /** Against the response and resolution targets, from when the request was raised. */
  sla: TicketSla;
}

const RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** Tickets currently with this provider across all its customers, most urgent first. */
export async function mspTickets(
  db: MspDb,
  mspOrgId: string,
  status: 'active' | 'all' = 'active',
): Promise<MspTicketRow[]> {
  const grants = await db.mspGrant.findMany({ where: { mspOrgId, status: 'active' } });
  const ids = grants.map((g) => g.customerOrgId);
  if (ids.length === 0) return [];
  const rows = await db.ticket.findMany({
    where: {
      orgId: { in: ids },
      routedTo: mspRoute(mspOrgId),
      ...(status === 'active' ? { status: { in: ['open', 'in_progress'] } } : {}),
    },
  });
  const orgs = await db.org.findMany({ where: { id: { in: ids } } });
  const name = new Map(orgs.map((o) => [o.id, o.name]));
  const comments = rows.length
    ? await db.ticketComment.findMany({
        where: { ticketId: { in: rows.map((r) => r.id) }, visibility: 'public' },
        orderBy: { createdAt: 'asc' },
      })
    : [];
  const now = new Date();
  return rows
    .map((t) => ({
      id: t.id,
      orgId: t.orgId,
      orgName: name.get(t.orgId) ?? 'Unknown organisation',
      title: t.title,
      status: t.status,
      priority: t.priority,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      sla: slaForTicket(
        t,
        comments.filter((c) => c.ticketId === t.id),
        now,
      ),
    }))
    .sort(
      (a, b) =>
        (RANK[a.priority] ?? 9) - (RANK[b.priority] ?? 9) ||
        slaUrgency(a.sla) - slaUrgency(b.sla) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
}
