import type { PrismaClient } from '@kestrel/db';
import {
  DEFAULT_USAGE_RULES,
  UsageRuleSchema,
  deviceLiveState,
  inUseNow,
  resolveGatewayId,
  type UsageRule,
} from '@kestrel/model';
import { effectiveStatus } from './gateway-status';
import type { HealthLevel } from './monitoring';
import { SEVERITY_RANK, type Severity } from './monitoring';
import { incidentVisible, inScope, type SiteScope } from './site-scope';

// The v2 Overview (docs/pivot-monitoring.md): the whole estate at a glance. Built from devices, not
// from room designs, so a room with no design at all still shows what is in it and how it is doing.
// Every query is scoped to the organisation, and to the caller's sites for a site-limited provider.
export type EstateDb = Pick<
  PrismaClient,
  | 'room'
  | 'gateway'
  | 'site'
  | 'area'
  | 'device'
  | 'deviceStatus'
  | 'incident'
  | 'ticket'
  | 'usageDefinition'
>;

type GatewayStatus = 'pending' | 'online' | 'offline';

export interface EstateRoom {
  id: string;
  name: string;
  type: string;
  kind: string;
  siteId: string;
  siteName: string;
  areaId: string | null;
  /** "Building A / Level 2", or empty when the room has no area. */
  areaPath: string;
  tags: string[];
  health: { level: HealthLevel; reasons: string[] };
  devices: {
    /** Active devices (polled). */
    active: number;
    online: number;
    offline: number;
    unknown: number;
    /** Passive assets: recorded, never monitored. */
    passive: number;
  };
  /** The gateways that poll this room's devices, and the worst state among them. */
  gateways: { id: string; name: string; status: GatewayStatus }[];
  gatewayStatus: GatewayStatus | null;
  openIncidents: number;
  worstSeverity: Severity | null;
  /** In use now, from the room's "in use" definition. Null until definitions exist (M3). */
  inUse: boolean | null;
  updatedAt: Date;
}

export interface EstateArea {
  id: string;
  siteId: string;
  parentId: string | null;
  name: string;
  label: string | null;
}

export interface EstateOverview {
  kpis: {
    liveIncidents: number;
    criticalIncidents: number;
    roomsNeedingAttention: number;
    rooms: number;
    roomsMonitored: number;
    roomsOnline: number;
    devicesActive: number;
    devicesOnline: number;
    devicesUnknown: number;
    devicesPassive: number;
    gateways: number;
    gatewaysOnline: number;
    openTickets: number;
    /** Null until in-use definitions (M3) and drift (M4) exist. */
    roomsInUse: number | null;
    driftCount: number | null;
  };
  sites: { id: string; name: string }[];
  areas: EstateArea[];
  rooms: EstateRoom[];
}

const OPEN_TICKET = ['open', 'in_progress'];

export async function estateOverview(
  db: EstateDb,
  orgId: string,
  now = new Date(),
  scope: SiteScope = null,
): Promise<EstateOverview> {
  const [
    allSites,
    allAreas,
    allRooms,
    allGateways,
    allDevices,
    allLegacy,
    allIncidents,
    tickets,
    definitions,
  ] = await Promise.all([
    db.site.findMany({ where: { orgId }, orderBy: { name: 'asc' } }),
    db.area.findMany({ where: { orgId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    db.room.findMany({ where: { orgId }, orderBy: { name: 'asc' } }),
    db.gateway.findMany({ where: { orgId } }),
    db.device.findMany({ where: { orgId } }),
    db.deviceStatus.findMany({ where: { orgId } }),
    db.incident.findMany({ where: { orgId, status: 'open' } }),
    db.ticket.findMany({ where: { orgId, status: { in: OPEN_TICKET } } }),
    db.usageDefinition.findMany({ where: { orgId, kind: 'av' } }),
  ]);
  const sites = allSites.filter((s) => inScope(scope, s.id));
  const areas = allAreas.filter((a) => inScope(scope, a.siteId));
  const rooms = allRooms.filter((r) => inScope(scope, r.siteId));
  const gateways = allGateways.filter((g) => inScope(scope, g.siteId));
  const roomIds = new Set(rooms.map((r) => r.id));
  const gatewayIds = new Set(gateways.map((g) => g.id));
  const incidents = allIncidents.filter((i) => incidentVisible(i, scope, roomIds, gatewayIds));
  const devices = allDevices.filter((d) => inScope(scope, d.siteId));
  const legacy = allLegacy.filter((d) => roomIds.has(d.roomId));

  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const areaById = new Map(areas.map((a) => [a.id, a]));
  const gwById = new Map(
    gateways.map((g) => [
      g.id,
      { id: g.id, name: g.name, status: effectiveStatus(g, now.getTime()) as GatewayStatus },
    ]),
  );
  // The gateway a site falls back on: the one it names, else its oldest.
  const defaultGatewayAt = new Map<string, string>();
  for (const g of [...gateways].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()))
    if (!defaultGatewayAt.has(g.siteId)) defaultGatewayAt.set(g.siteId, g.id);
  for (const s of sites) {
    const named = s.defaultGatewayId
      ? gateways.find((g) => g.id === s.defaultGatewayId && g.siteId === s.id)
      : undefined;
    if (named) defaultGatewayAt.set(s.id, named.id);
  }
  // The rule for "in use": a room's own, else the organisation's, else the usual one.
  const parsedRule = (v: unknown): UsageRule | null => {
    const r = UsageRuleSchema.safeParse(v);
    return r.success ? r.data : null;
  };
  const orgRule = parsedRule(definitions.find((d) => d.roomId === null)?.rule);
  const roomById = new Map(rooms.map((r) => [r.id, r]));

  const pathOf = (areaId: string | null) => {
    const parts: string[] = [];
    for (let id = areaId, guard = 0; id && guard < 5; guard++) {
      const a = areaById.get(id);
      if (!a) break;
      parts.unshift(a.name);
      id = a.parentId;
    }
    return parts.join(' / ');
  };

  const rows: EstateRoom[] = rooms.map((r) => {
    const own = devices.filter((d) => d.roomId === r.id);
    const ownLegacy = legacy.filter((d) => d.roomId === r.id);
    const gwSeen = new Map<string, { id: string; name: string; status: GatewayStatus }>();
    const note = (id: string | null | undefined) => {
      const g = id ? gwById.get(id) : undefined;
      if (g) gwSeen.set(g.id, g);
      return g;
    };
    if (r.gatewayId) note(r.gatewayId);

    let online = 0;
    let offline = 0;
    let unknown = 0;
    let active = 0;
    let passive = 0;
    for (const d of own) {
      if (d.kind !== 'active') {
        passive++;
        continue;
      }
      active++;
      const gwId = resolveGatewayId({
        deviceGatewayId: d.gatewayId,
        roomGatewayId: r.gatewayId,
        siteGatewayId: defaultGatewayAt.get(d.siteId) ?? null,
      });
      const gw = note(gwId);
      const state = deviceLiveState({
        kind: d.kind,
        online: d.online,
        gatewayOnline: gw?.status === 'online',
      });
      if (state === 'online') online++;
      else if (state === 'offline') offline++;
      else unknown++;
    }
    // Devices from the older room designs count as active devices too, until they are moved over.
    const roomGw = r.gatewayId ? gwById.get(r.gatewayId) : undefined;
    for (const d of ownLegacy) {
      active++;
      if (roomGw && roomGw.status !== 'online') unknown++;
      else if (d.online) online++;
      else offline++;
    }

    const open = incidents.filter((i) => i.roomId === r.id);
    const worst = open.reduce<Severity | null>(
      (w, i) =>
        !w || SEVERITY_RANK[i.severity as Severity] > SEVERITY_RANK[w]
          ? (i.severity as Severity)
          : w,
      null,
    );
    const gws = [...gwSeen.values()];
    const gatewayStatus: GatewayStatus | null = gws.length
      ? gws.some((g) => g.status === 'offline')
        ? 'offline'
        : gws.some((g) => g.status === 'pending')
          ? 'pending'
          : 'online'
      : null;

    const reasons: string[] = [];
    let level: HealthLevel;
    if (active === 0) {
      level = 'unknown';
      reasons.push(passive > 0 ? 'Only recorded assets, nothing is monitored' : 'No devices yet');
    } else if (gws.length === 0 && ownLegacy.length === 0) {
      level = 'unknown';
      reasons.push('Not assigned to a gateway');
    } else if (open.length > 0 || offline > 0) {
      level = worst === 'critical' || offline === active ? 'down' : 'degraded';
      if (offline > 0) reasons.push(`${offline} of ${active} devices offline`);
      if (open.length > 0)
        reasons.push(`${open.length} open incident${open.length === 1 ? '' : 's'}`);
    } else if (unknown > 0) {
      level = 'unknown';
      reasons.push(
        gatewayStatus === 'offline'
          ? 'A gateway is offline, so some devices cannot be seen'
          : 'Waiting to hear from devices',
      );
    } else {
      level = 'healthy';
    }
    // In use now, by the room's rule, from what its monitored devices last said. Unknown when none has spoken.
    const speaking = own.filter((d) => d.kind === 'active' && d.online !== null);
    let inUse: boolean | null = null;
    if (speaking.length > 0) {
      const rule =
        parsedRule(definitions.find((d) => d.roomId === r.id)?.rule) ??
        orgRule ??
        DEFAULT_USAGE_RULES.av;
      const readings = new Map<string, string>();
      for (const d of speaking) {
        readings.set(`${d.id}|online`, String(d.online));
        for (const [k, v] of Object.entries((d.feedback ?? {}) as Record<string, unknown>))
          if (v !== undefined && v !== null) readings.set(`${d.id}|${k}`, String(v));
      }
      inUse = inUseNow(
        rule,
        own.map((d) => ({ id: d.id, category: d.category })),
        (id, f) => readings.get(`${id}|${f}`),
      );
    }
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      kind: r.kind,
      siteId: r.siteId,
      siteName: siteName.get(r.siteId) ?? '',
      areaId: r.areaId,
      areaPath: pathOf(r.areaId),
      tags: r.tags,
      health: { level, reasons },
      devices: { active, online, offline, unknown, passive },
      gateways: gws,
      gatewayStatus,
      openIncidents: open.length,
      worstSeverity: worst,
      inUse,
      updatedAt: r.updatedAt,
    };
  });

  // Rooms that have something to watch, and that are fine right now.
  const monitored = rows.filter((r) => r.devices.active > 0);
  const gatewaysOnline = gateways.filter((g) => gwById.get(g.id)?.status === 'online').length;
  const activeDevices = rows.reduce((n, r) => n + r.devices.active, 0);
  // Tickets a site-limited provider can see are those about rooms it can see.
  const ticketCount = tickets.filter(
    (t) => scope === null || (t.roomId && roomById.has(t.roomId)),
  ).length;

  // Monitored devices with a held setting that currently reads wrong.
  const driftDevices = devices.filter((d) =>
    Object.entries((d.configState ?? {}) as Record<string, { drifted?: boolean }>).some(
      ([f, s]) => f !== '__push' && s?.drifted,
    ),
  ).length;

  return {
    kpis: {
      liveIncidents: incidents.length,
      criticalIncidents: incidents.filter((i) => i.severity === 'critical').length,
      roomsNeedingAttention: rows.filter((r) => r.openIncidents > 0).length,
      rooms: rows.length,
      roomsMonitored: monitored.length,
      roomsOnline: monitored.filter((r) => r.health.level === 'healthy').length,
      devicesActive: activeDevices,
      devicesOnline: rows.reduce((n, r) => n + r.devices.online, 0),
      devicesUnknown: rows.reduce((n, r) => n + r.devices.unknown, 0),
      devicesPassive: rows.reduce((n, r) => n + r.devices.passive, 0),
      gateways: gateways.length,
      gatewaysOnline,
      openTickets: ticketCount,
      roomsInUse: rows.some((r) => r.inUse !== null)
        ? rows.filter((r) => r.inUse === true).length
        : null,
      driftCount: driftDevices,
    },
    sites: sites.map((s) => ({ id: s.id, name: s.name })),
    areas: areas.map((a) => ({
      id: a.id,
      siteId: a.siteId,
      parentId: a.parentId,
      name: a.name,
      label: a.label,
    })),
    rooms: rows,
  };
}
