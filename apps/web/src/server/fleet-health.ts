import type { PrismaClient } from '@kestrel/db';
import { effectiveStatus } from './gateway-status';
import { publishedVersions, updateStatus, type Channel } from './gateway-updates';

// What is wrong across every customer right now, for the staff portal. Read only. It shows names
// of gateways and rooms (operational metadata), never room designs, credentials or people.
export type FleetDb = Pick<
  PrismaClient,
  'org' | 'gateway' | 'site' | 'room' | 'incident' | 'deployment' | 'ticket'
>;

const DAY = 86_400_000;
const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };
/** Deployment stages that mean a release did not go live. */
const NOT_LIVE = ['failed', 'rolled_back'];
const MAX_LISTED = 50;

export interface OfflineGateway {
  id: string;
  name: string;
  orgId: string;
  orgName: string;
  siteName: string;
  rooms: number;
  version: string | null;
  lastSeenAt: Date | null;
}

export interface FleetIncident {
  id: string;
  orgId: string;
  orgName: string;
  severity: string;
  title: string;
  roomName: string | null;
  openedAt: Date;
  occurrences: number;
  acknowledged: boolean;
}

export interface FailedDeployment {
  id: string;
  orgId: string;
  orgName: string;
  roomName: string;
  status: string;
  error: string | null;
  at: Date;
}

export interface BehindGateway {
  id: string;
  name: string;
  orgId: string;
  orgName: string;
  channel: Channel;
  version: string | null;
  latest: string | null;
}

export interface AttentionRow {
  orgId: string;
  orgName: string;
  offlineGateways: number;
  criticalIncidents: number;
  openIncidents: number;
  failedDeployments: number;
}

export interface FleetHealth {
  summary: {
    organisations: number;
    gateways: number;
    gatewaysOnline: number;
    gatewaysOffline: number;
    gatewaysBehind: number;
    openIncidents: number;
    criticalIncidents: number;
    failedDeployments: number;
    /** Tickets with Kestrel that are urgent or high and not finished. */
    urgentTickets: number;
    organisationsNeedingAttention: number;
  };
  /** Organisations with something wrong, worst first. */
  attention: AttentionRow[];
  offlineGateways: OfflineGateway[];
  incidents: FleetIncident[];
  failedDeployments: FailedDeployment[];
  behindGateways: BehindGateway[];
}

export async function fleetHealth(
  db: FleetDb,
  now = new Date(),
  latest?: Record<Channel, string | null>,
): Promise<FleetHealth> {
  const since = new Date(now.getTime() - 7 * DAY);
  const newest = latest ?? (await publishedVersions());
  const [orgs, gateways, sites, rooms, incidents, deployments, tickets] = await Promise.all([
    db.org.findMany({ where: { kind: 'customer' } }),
    db.gateway.findMany({}),
    db.site.findMany({}),
    db.room.findMany({}),
    db.incident.findMany({ where: { status: 'open' } }),
    db.deployment.findMany({ where: { status: { in: NOT_LIVE }, createdAt: { gte: since } } }),
    db.ticket.findMany({ where: { routedTo: 'kestrel', status: { in: ['open', 'in_progress'] } } }),
  ]);
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const roomName = new Map(rooms.map((r) => [r.id, r.name]));
  // Ignore anything belonging to an organisation that is not a customer (or no longer exists).
  const mine = <T extends { orgId: string }>(rows: T[]) => rows.filter((r) => orgName.has(r.orgId));

  const gws = mine(gateways).map((g) => ({
    g,
    status: effectiveStatus(g, now.getTime()),
    update: updateStatus(g, newest),
  }));
  const offline = gws.filter((x) => x.status === 'offline');
  const behind = gws.filter((x) => x.update.status === 'behind');
  const open = mine(incidents);
  const failed = mine(deployments);

  const offlineGateways: OfflineGateway[] = offline
    .map(({ g }) => ({
      id: g.id,
      name: g.name,
      orgId: g.orgId,
      orgName: orgName.get(g.orgId)!,
      siteName: siteName.get(g.siteId) ?? '',
      rooms: rooms.filter((r) => r.gatewayId === g.id).length,
      version: g.version,
      lastSeenAt: g.lastSeenAt,
    }))
    // Longest silent first; never-seen last.
    .sort((a, b) => (a.lastSeenAt?.getTime() ?? Infinity) - (b.lastSeenAt?.getTime() ?? Infinity))
    .slice(0, MAX_LISTED);

  const fleetIncidents: FleetIncident[] = open
    .map((i) => ({
      id: i.id,
      orgId: i.orgId,
      orgName: orgName.get(i.orgId)!,
      severity: i.severity,
      title: i.title,
      roomName: i.roomId ? (roomName.get(i.roomId) ?? null) : null,
      openedAt: i.openedAt,
      occurrences: i.occurrences,
      acknowledged: i.acknowledgedAt !== null,
    }))
    .sort(
      (a, b) =>
        (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
        a.openedAt.getTime() - b.openedAt.getTime(),
    )
    .slice(0, MAX_LISTED);

  const failedDeployments: FailedDeployment[] = failed
    .map((d) => ({
      id: d.id,
      orgId: d.orgId,
      orgName: orgName.get(d.orgId)!,
      roomName: roomName.get(d.roomId) ?? 'Deleted room',
      status: d.status,
      error: d.error,
      at: d.finishedAt ?? d.createdAt,
    }))
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, MAX_LISTED);

  const behindGateways: BehindGateway[] = behind
    .map(({ g, update }) => ({
      id: g.id,
      name: g.name,
      orgId: g.orgId,
      orgName: orgName.get(g.orgId)!,
      channel: g.channel as Channel,
      version: g.version,
      latest: update.latest,
    }))
    .slice(0, MAX_LISTED);

  const attention = new Map<string, AttentionRow>();
  const row = (orgId: string): AttentionRow => {
    let r = attention.get(orgId);
    if (!r) {
      r = {
        orgId,
        orgName: orgName.get(orgId)!,
        offlineGateways: 0,
        criticalIncidents: 0,
        openIncidents: 0,
        failedDeployments: 0,
      };
      attention.set(orgId, r);
    }
    return r;
  };
  for (const { g } of offline) row(g.orgId).offlineGateways++;
  for (const i of open) {
    row(i.orgId).openIncidents++;
    if (i.severity === 'critical') row(i.orgId).criticalIncidents++;
  }
  for (const d of failed) row(d.orgId).failedDeployments++;
  const score = (r: AttentionRow) =>
    r.criticalIncidents * 3 + r.offlineGateways * 2 + r.failedDeployments + r.openIncidents;

  return {
    summary: {
      organisations: orgs.length,
      gateways: gws.length,
      gatewaysOnline: gws.filter((x) => x.status === 'online').length,
      gatewaysOffline: offline.length,
      gatewaysBehind: behind.length,
      openIncidents: open.length,
      criticalIncidents: open.filter((i) => i.severity === 'critical').length,
      failedDeployments: failed.length,
      urgentTickets: mine(tickets).filter((t) => t.priority === 'urgent' || t.priority === 'high')
        .length,
      organisationsNeedingAttention: attention.size,
    },
    attention: [...attention.values()].sort(
      (a, b) => score(b) - score(a) || a.orgName.localeCompare(b.orgName),
    ),
    offlineGateways,
    incidents: fleetIncidents,
    failedDeployments,
    behindGateways,
  };
}
