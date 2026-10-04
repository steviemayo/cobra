import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@kestrel/db';
import { TRIAL_DAYS, mspRoute } from '@kestrel/model';
import { writeAudit } from './audit';
import { estateOverview, type EstateDb } from './estate-overview';
import { incidentVisible, type SiteScope } from './site-scope';

// A service provider's portfolio (docs/pivot-monitoring.md, "Service providers"): every customer it
// looks after with the numbers that matter, all customers' incidents in one place, the provider's
// own library copied to customers, and a customer set up on a customer's behalf. Each customer's
// data stays in the customer's organisation and is read with the scope of the grant. The provider's
// own organisation is its Internal estate and never appears in these lists.
export type PortfolioDb = EstateDb &
  Pick<
    PrismaClient,
    | 'org'
    | 'member'
    | 'mspGrant'
    | 'auditLog'
    | 'ticket'
    | 'invite'
    | 'orgBilling'
    | 'configProfile'
    | 'pmTemplate'
  >;

type Result<T = { id: string }> = { ok: true; value: T } | { ok: false; message: string };
const bad = (message: string): { ok: false; message: string } => ({ ok: false, message });

export type PortfolioHealth = 'down' | 'degraded' | 'healthy' | 'unknown';

export interface PortfolioRow {
  grantId: string;
  orgId: string;
  name: string;
  role: string;
  /** How many sites the connection is limited to. 0: the whole organisation. */
  limitedToSites: number;
  accountManager: string | null;
  tags: string[];
  endsAt: Date | null;
  rooms: number;
  roomsMonitored: number;
  roomsOnline: number;
  roomsNeedingAttention: number;
  devicesActive: number;
  devicesOnline: number;
  devicesUnknown: number;
  liveIncidents: number;
  criticalIncidents: number;
  gateways: number;
  gatewaysOnline: number;
  driftCount: number;
  pmOverdue: number;
  /** Open tickets sent to this provider. */
  ticketsWithUs: number;
  health: PortfolioHealth;
}

export function healthOf(k: {
  criticalIncidents: number;
  roomsNeedingAttention: number;
  driftCount: number;
  pmOverdue: number;
  gateways: number;
  gatewaysOnline: number;
  roomsMonitored: number;
}): PortfolioHealth {
  if (k.criticalIncidents > 0) return 'down';
  if (
    k.roomsNeedingAttention > 0 ||
    k.driftCount > 0 ||
    k.pmOverdue > 0 ||
    k.gatewaysOnline < k.gateways
  )
    return 'degraded';
  if (k.roomsMonitored === 0) return 'unknown';
  return 'healthy';
}

const scopeOf = (siteIds: string[]): SiteScope => (siteIds.length === 0 ? null : siteIds);

/** The provider's customers, each read through the estate query with the scope of its grant. */
export async function portfolio(
  db: PortfolioDb,
  mspOrgId: string,
  now = new Date(),
): Promise<PortfolioRow[]> {
  const grants = await db.mspGrant.findMany({
    where: { mspOrgId, status: 'active' },
    orderBy: { createdAt: 'asc' },
  });
  if (grants.length === 0) return [];
  const orgs = await db.org.findMany({ where: { id: { in: grants.map((g) => g.customerOrgId) } } });
  const name = new Map(orgs.map((o) => [o.id, o.name]));
  const rows: PortfolioRow[] = [];
  for (const g of grants) {
    const est = await estateOverview(db, g.customerOrgId, now, scopeOf(g.siteIds));
    const k = est.kpis;
    const tickets = await db.ticket.findMany({
      where: {
        orgId: g.customerOrgId,
        routedTo: mspRoute(mspOrgId),
        status: { in: ['open', 'in_progress'] },
      },
    });
    rows.push({
      grantId: g.id,
      orgId: g.customerOrgId,
      name: name.get(g.customerOrgId) ?? 'Unknown organisation',
      role: g.role,
      limitedToSites: g.siteIds.length,
      accountManager: g.accountManager,
      tags: g.tags,
      endsAt: g.endsAt,
      rooms: k.rooms,
      roomsMonitored: k.roomsMonitored,
      roomsOnline: k.roomsOnline,
      roomsNeedingAttention: k.roomsNeedingAttention,
      devicesActive: k.devicesActive,
      devicesOnline: k.devicesOnline,
      devicesUnknown: k.devicesUnknown,
      liveIncidents: k.liveIncidents,
      criticalIncidents: k.criticalIncidents,
      gateways: k.gateways,
      gatewaysOnline: k.gatewaysOnline,
      driftCount: k.driftCount ?? 0,
      pmOverdue: k.pmOverdue,
      ticketsWithUs: tickets.length,
      health: healthOf({ ...k, driftCount: k.driftCount ?? 0 }),
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export interface CrossIncident {
  id: string;
  customerOrgId: string;
  customerName: string;
  roomId: string | null;
  roomName: string | null;
  kind: string;
  severity: string;
  status: string;
  title: string;
  openedAt: Date;
  resolvedAt: Date | null;
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

/** Open incidents (and those closed in the last week) across every customer, most serious first. */
export async function incidentsAcrossCustomers(
  db: PortfolioDb,
  mspOrgId: string,
  now = new Date(),
  includeResolved = false,
): Promise<CrossIncident[]> {
  const grants = await db.mspGrant.findMany({ where: { mspOrgId, status: 'active' } });
  const orgs = await db.org.findMany({ where: { id: { in: grants.map((g) => g.customerOrgId) } } });
  const out: CrossIncident[] = [];
  for (const g of grants) {
    const [incidents, rooms, gateways] = await Promise.all([
      db.incident.findMany({ where: { orgId: g.customerOrgId } }),
      db.room.findMany({ where: { orgId: g.customerOrgId } }),
      db.gateway.findMany({ where: { orgId: g.customerOrgId } }),
    ]);
    const scope = scopeOf(g.siteIds);
    const roomIds = new Set(
      rooms.filter((r) => scope === null || scope.includes(r.siteId)).map((r) => r.id),
    );
    const gwIds = new Set(
      gateways.filter((x) => scope === null || scope.includes(x.siteId)).map((x) => x.id),
    );
    const weekAgo = now.getTime() - 7 * 86_400_000;
    for (const i of incidents) {
      if (!incidentVisible(i, scope, roomIds, gwIds)) continue;
      if (
        i.status !== 'open' &&
        !(includeResolved && i.resolvedAt && i.resolvedAt.getTime() >= weekAgo)
      )
        continue;
      out.push({
        id: i.id,
        customerOrgId: g.customerOrgId,
        customerName: orgs.find((o) => o.id === g.customerOrgId)?.name ?? 'Unknown',
        roomId: i.roomId,
        roomName: rooms.find((r) => r.id === i.roomId)?.name ?? null,
        kind: i.kind,
        severity: i.severity,
        status: i.status,
        title: i.title,
        openedAt: i.openedAt,
        resolvedAt: i.resolvedAt,
      });
    }
  }
  return out.sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
      b.openedAt.getTime() - a.openedAt.getTime(),
  );
}

// ---- What a provider did, shown to the customer --------------------------------------------------

export interface ProviderActivityRow {
  id: string;
  at: Date;
  action: string;
  provider: string;
  target: string | null;
}

/**
 * Actions in a customer's activity log made by people from a service provider (not members of the
 * customer itself), labelled with the provider, so a customer can see what its providers did.
 */
export async function providerActivity(
  db: PortfolioDb,
  customerOrgId: string,
  limit = 100,
): Promise<ProviderActivityRow[]> {
  const grants = await db.mspGrant.findMany({
    where: { customerOrgId, status: { in: ['active', 'ended'] } },
  });
  if (grants.length === 0) return [];
  const [members, providerMembers, providers, audit] = await Promise.all([
    db.member.findMany({ where: { orgId: customerOrgId } }),
    db.member.findMany({ where: { orgId: { in: [...new Set(grants.map((g) => g.mspOrgId))] } } }),
    db.org.findMany({ where: { id: { in: grants.map((g) => g.mspOrgId) } } }),
    db.auditLog.findMany({
      where: { orgId: customerOrgId },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    }),
  ]);
  const own = new Set(members.map((m) => m.userId));
  const providerOf = new Map<string, string>();
  for (const m of providerMembers)
    if (!own.has(m.userId))
      providerOf.set(m.userId, providers.find((p) => p.id === m.orgId)?.name ?? 'Service provider');
  const out: ProviderActivityRow[] = [];
  for (const a of audit) {
    const who = a.actorId ? providerOf.get(a.actorId) : undefined;
    if (!who) continue;
    out.push({
      id: a.id,
      at: a.createdAt,
      action: a.action,
      provider: who,
      target: a.target ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ---- Grants --------------------------------------------------------------------------------------

/** Ends every connection whose end date has passed. Run daily. */
export async function expireGrants(db: PortfolioDb, now = new Date()): Promise<number> {
  const due = (await db.mspGrant.findMany({ where: { status: 'active' } })).filter(
    (g) => g.endsAt && g.endsAt.getTime() <= now.getTime(),
  );
  for (const g of due) {
    await db.mspGrant.update({ where: { id: g.id }, data: { status: 'ended', endedAt: now } });
    await writeAudit(
      { orgId: g.customerOrgId, actorId: null, action: 'msp.expired', target: g.mspOrgId },
      db as never,
    );
    await writeAudit(
      { orgId: g.mspOrgId, actorId: null, action: 'msp.expired', target: g.customerOrgId },
      db as never,
    );
  }
  return due.length;
}

/** The customer's owner sets or clears when a connection ends by itself. */
export async function setGrantEnd(
  db: PortfolioDb,
  input: { customerOrgId: string; grantId: string; endsAt: Date | null },
  now = new Date(),
): Promise<Result> {
  const g = await db.mspGrant.findFirst({
    where: {
      id: input.grantId,
      customerOrgId: input.customerOrgId,
      status: { in: ['pending', 'active'] },
    },
  });
  if (!g) return bad('No such connection');
  if (input.endsAt && input.endsAt.getTime() <= now.getTime())
    return bad('Choose a date in the future');
  await db.mspGrant.update({ where: { id: g.id }, data: { endsAt: input.endsAt } });
  return { ok: true, value: { id: g.id } };
}

/** The provider's own notes about a customer: who looks after it, and labels to filter by. */
export async function updateCustomerMeta(
  db: PortfolioDb,
  input: { mspOrgId: string; grantId: string; accountManager?: string | null; tags?: string[] },
): Promise<Result> {
  const g = await db.mspGrant.findFirst({
    where: { id: input.grantId, mspOrgId: input.mspOrgId, status: 'active' },
  });
  if (!g) return bad('No such customer');
  const data: Record<string, unknown> = {};
  if (input.accountManager !== undefined)
    data.accountManager = input.accountManager?.trim() || null;
  if (input.tags)
    data.tags = [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))].slice(0, 20);
  await db.mspGrant.update({ where: { id: g.id }, data });
  return { ok: true, value: { id: g.id } };
}

// ---- The provider's library ----------------------------------------------------------------------

/**
 * Copies one of the provider's own configuration profiles or maintenance checklists into customers
 * that let it manage them. The customer gets its own copy (renamed if it has one of that name), so
 * the customer's copy is the customer's to change and a later change here does not reach it.
 */
export async function libraryPush(
  db: PortfolioDb,
  input: {
    mspOrgId: string;
    kind: 'profile' | 'pm_template';
    sourceId: string;
    customerOrgIds: string[];
    userId: string | null;
  },
): Promise<
  Result<{
    copied: { orgId: string; name: string }[];
    skipped: { orgId: string; reason: string }[];
  }>
> {
  const provider = await db.org.findFirst({ where: { id: input.mspOrgId, kind: 'msp' } });
  if (!provider) return bad('Only a service provider has a library');
  const source =
    input.kind === 'profile'
      ? await db.configProfile.findFirst({ where: { id: input.sourceId, orgId: input.mspOrgId } })
      : await db.pmTemplate.findFirst({ where: { id: input.sourceId, orgId: input.mspOrgId } });
  if (!source) return bad('That is not in your library');
  const copied: { orgId: string; name: string }[] = [];
  const skipped: { orgId: string; reason: string }[] = [];
  for (const orgId of new Set(input.customerOrgIds)) {
    const grant = await db.mspGrant.findFirst({
      where: { mspOrgId: input.mspOrgId, customerOrgId: orgId, status: 'active' },
    });
    if (!grant) {
      skipped.push({ orgId, reason: 'Not connected' });
      continue;
    }
    if (grant.role !== 'manage') {
      skipped.push({ orgId, reason: 'You only have support or view access' });
      continue;
    }
    const taken = async (n: string) =>
      input.kind === 'profile'
        ? db.configProfile.findFirst({ where: { orgId, name: n } })
        : db.pmTemplate.findFirst({ where: { orgId, name: n } });
    let name = source.name;
    if (await taken(name)) name = `${source.name} (from ${provider.name})`;
    for (let n = 2; await taken(name); n++) name = `${source.name} (from ${provider.name}) ${n}`;
    if (input.kind === 'profile') {
      const s = source as NonNullable<
        Awaited<ReturnType<PortfolioDb['configProfile']['findFirst']>>
      >;
      await db.configProfile.create({
        data: {
          orgId,
          name,
          description: s.description,
          category: s.category,
          params: s.params as never,
          version: 1,
          createdBy: input.userId,
        },
      });
    } else {
      const s = source as NonNullable<Awaited<ReturnType<PortfolioDb['pmTemplate']['findFirst']>>>;
      await db.pmTemplate.create({
        data: {
          orgId,
          name,
          appliesTo: s.appliesTo,
          category: s.category,
          items: s.items as never,
          version: 1,
          createdBy: input.userId,
        },
      });
    }
    await writeAudit(
      {
        orgId,
        actorId: input.userId,
        action: 'msp.library_push',
        target: name,
        meta: { kind: input.kind, from: provider.name },
      },
      db as never,
    );
    copied.push({ orgId, name });
  }
  return { ok: true, value: { copied, skipped } };
}

// ---- Setting up a customer for someone else ------------------------------------------------------

const INVITE_DAYS = 14;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * A provider creates a customer organisation on a customer's behalf: an organisation with a trial,
 * the provider connected with full management access, and (optionally) an invitation for the
 * customer's owner, whose acceptance hands the organisation over. Until then the provider works in
 * it through the connection like any customer.
 */
export async function createCustomer(
  db: PortfolioDb,
  input: {
    mspOrgId: string;
    name: string;
    ownerEmail?: string | null;
    by: { userId: string; email: string | null };
  },
  now = new Date(),
): Promise<Result<{ id: string; inviteToken: string | null }>> {
  const provider = await db.org.findFirst({ where: { id: input.mspOrgId, kind: 'msp' } });
  if (!provider) return bad('Only a service provider can do this');
  const name = input.name.trim();
  if (!name) return bad('Give the customer a name');
  const org = await db.org.create({
    data: {
      name,
      kind: 'customer',
      billing: { create: { trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 86_400_000) } },
    },
  });
  await db.mspGrant.create({
    data: {
      mspOrgId: provider.id,
      customerOrgId: org.id,
      role: 'manage',
      siteIds: [],
      // A customer the provider made itself already trusts it with its team (PA-2).
      mayAddPeople: true,
      status: 'active',
      invitedBy: input.by.userId,
      invitedByEmail: input.by.email,
      respondedBy: input.by.userId,
      respondedAt: now,
    },
  });
  let inviteToken: string | null = null;
  const email = input.ownerEmail?.trim().toLowerCase();
  if (email) {
    inviteToken = randomBytes(24).toString('base64url');
    await db.invite.create({
      data: {
        orgId: org.id,
        email,
        role: 'owner',
        tokenHash: hashToken(inviteToken),
        invitedBy: input.by.userId,
        expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000),
      },
    });
  }
  await writeAudit(
    {
      orgId: org.id,
      actorId: input.by.userId,
      action: 'org.create_by_provider',
      target: org.id,
      meta: { provider: provider.name, ownerInvited: !!email },
    },
    db as never,
  );
  await writeAudit(
    {
      orgId: provider.id,
      actorId: input.by.userId,
      action: 'msp.customer_created',
      target: org.id,
      meta: { name },
    },
    db as never,
  );
  return { ok: true, value: { id: org.id, inviteToken } };
}
