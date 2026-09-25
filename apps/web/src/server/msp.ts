import type { Prisma, PrismaClient } from '@kestrel/db';
import {
  bestMspRole,
  effectiveMspRole,
  grantTakesTickets,
  mspRoute,
  type GrantRole,
  type OrgRole,
} from '@kestrel/model';
import { effectiveStatus } from './gateway-status';

// Managed service providers. An MSP is an organisation of kind "msp"; a customer's owner invites
// it, the MSP's owner accepts, and either side can end it. While it is active, the MSP's people
// work inside the customer at the lower of their own role and the grant's role (never owner).
// Functions take the database as a parameter so they can be tested without one.
export type MspDb = Pick<
  PrismaClient,
  'org' | 'member' | 'mspGrant' | 'auditLog' | 'ticket' | 'room' | 'gateway' | 'incident'
>;

export class MspError extends Error {}

const LIVE = ['pending', 'active'];

/** A short code the provider gives customers so they can invite it: its organisation id. */
export const providerCode = (mspOrgId: string) => mspOrgId;

async function audit(
  db: MspDb,
  orgId: string,
  actorId: string | null,
  action: string,
  meta: Record<string, unknown>,
) {
  await db.auditLog.create({
    data: { orgId, actorId, action, target: orgId, meta: meta as Prisma.InputJsonValue },
  });
}

/** A customer's owner invites a provider. The provider still has to accept. */
export async function inviteMsp(
  db: MspDb,
  args: {
    customerOrgId: string;
    mspOrgId: string;
    role: GrantRole;
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
      status: 'pending',
      invitedBy: args.by.userId,
      invitedByEmail: args.by.email,
    },
  });
  await audit(db, customer.id, args.by.userId, 'msp.invite', { msp: msp.name, role: args.role });
  await audit(db, msp.id, null, 'msp.invited', { customer: customer.name, role: args.role });
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
  await audit(db, g.customerOrgId, null, action, { msp: msp?.name });
  await audit(db, g.mspOrgId, args.by, action, { customer: customer?.name });
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
  const [msp, customer] = await Promise.all([
    db.org.findFirst({ where: { id: g.mspOrgId } }),
    db.org.findFirst({ where: { id: g.customerOrgId } }),
  ]);
  const byCustomer = args.orgId === g.customerOrgId;
  await audit(db, g.customerOrgId, byCustomer ? args.by : null, 'msp.ended', {
    msp: msp?.name,
    by: byCustomer ? 'you' : 'the service provider',
  });
  await audit(db, g.mspOrgId, byCustomer ? null : args.by, 'msp.ended', {
    customer: customer?.name,
    by: byCustomer ? 'the customer' : 'you',
  });
}

export interface CustomerGrantView {
  id: string;
  mspOrgId: string;
  mspName: string;
  role: string;
  status: string;
  createdAt: Date;
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
  return grants.map((g) => ({
    id: g.id,
    mspOrgId: g.mspOrgId,
    mspName: name.get(g.mspOrgId) ?? 'Unknown provider',
    role: g.role,
    status: g.status,
    createdAt: g.createdAt,
  }));
}

export interface MspInviteView {
  id: string;
  customerName: string;
  role: string;
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
    invitedByEmail: g.invitedByEmail,
    createdAt: g.createdAt,
  }));
}

// ---- Access ---------------------------------------------------------------------------------

export interface MspAccess {
  role: OrgRole;
  mspOrgId: string;
  mspName: string;
}

/**
 * What this person may do inside `customerOrgId` because of a service provider they belong to, or
 * null. Only active, whole-organisation grants count (site-limited grants come later).
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
  const usable = grants.filter((g) => g.siteIds.length === 0);
  if (usable.length === 0) return null;
  const roleIn = new Map(memberships.map((m) => [m.orgId, m.role as OrgRole]));
  const candidates = usable.map((g) => ({
    memberRole: roleIn.get(g.mspOrgId)!,
    grant: g.role as GrantRole,
    mspOrgId: g.mspOrgId,
  }));
  const role = bestMspRole(candidates);
  if (!role) return null;
  // Name the provider that gave the best role, for the banner and the activity log.
  const from = candidates.find((c) => effectiveMspRole(c.memberRole, c.grant) === role)!;
  const msp = await db.org.findFirst({ where: { id: from.mspOrgId } });
  return { role, mspOrgId: from.mspOrgId, mspName: msp?.name ?? 'Service provider' };
}

export interface ManagedCustomer {
  orgId: string;
  name: string;
  role: OrgRole;
  mspOrgId: string;
  mspName: string;
}

/** Every customer this person can work in through a provider, for the organisation switcher. */
export async function managedCustomers(db: MspDb, userId: string): Promise<ManagedCustomer[]> {
  const memberships = await db.member.findMany({ where: { userId } });
  if (memberships.length === 0) return [];
  const grants = await db.mspGrant.findMany({
    where: { status: 'active', mspOrgId: { in: memberships.map((m) => m.orgId) } },
  });
  const whole = grants.filter((g) => g.siteIds.length === 0);
  const customerIds = [...new Set(whole.map((g) => g.customerOrgId))];
  const [customers, providers] = await Promise.all([
    db.org.findMany({ where: { id: { in: customerIds } } }),
    db.org.findMany({ where: { id: { in: [...new Set(whole.map((g) => g.mspOrgId))] } } }),
  ]);
  const roleIn = new Map(memberships.map((m) => [m.orgId, m.role as OrgRole]));
  const mspName = new Map(providers.map((o) => [o.id, o.name]));
  return customers
    .map((c) => {
      const mine = whole
        .filter((g) => g.customerOrgId === c.id)
        .map((g) => ({
          memberRole: roleIn.get(g.mspOrgId)!,
          grant: g.role as GrantRole,
          mspOrgId: g.mspOrgId,
        }));
      const role = bestMspRole(mine);
      const from = mine.find((m) => effectiveMspRole(m.memberRole, m.grant) === role);
      return role && from
        ? {
            orgId: c.id,
            name: c.name,
            role,
            mspOrgId: from.mspOrgId,
            mspName: mspName.get(from.mspOrgId) ?? 'Service provider',
          }
        : null;
    })
    .filter((x): x is ManagedCustomer => x !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Where a new ticket goes: to the customer's service provider if it has an active one that takes
 * tickets (the oldest such connection), otherwise to the customer's own team.
 */
export async function routeForNewTicket(db: MspDb, customerOrgId: string): Promise<string> {
  const grants = await db.mspGrant.findMany({
    where: { customerOrgId, status: 'active' },
    orderBy: { createdAt: 'asc' },
  });
  const g = grants.find((x) => x.siteIds.length === 0 && grantTakesTickets(x.role as GrantRole));
  return g ? mspRoute(g.mspOrgId) : 'org';
}

// ---- The provider's own view -----------------------------------------------------------------

export interface ManagedRow {
  grantId: string;
  orgId: string;
  name: string;
  role: string;
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
      const gw = gateways.filter((x) => x.orgId === g.customerOrgId);
      return {
        grantId: g.id,
        orgId: g.customerOrgId,
        name: name.get(g.customerOrgId) ?? 'Unknown organisation',
        role: g.role,
        rooms: rooms.filter((r) => r.orgId === g.customerOrgId && r.kind !== 'combined').length,
        gateways: gw.length,
        gatewaysOnline: gw.filter((x) => effectiveStatus(x, now.getTime()) === 'online').length,
        openIncidents: incidents.filter((i) => i.orgId === g.customerOrgId).length,
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
    }))
    .sort(
      (a, b) =>
        (RANK[a.priority] ?? 9) - (RANK[b.priority] ?? 9) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
}
