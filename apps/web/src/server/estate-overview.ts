import type { PrismaClient } from '@kestrel/db';
import {
  DEFAULT_USAGE_RULES,
  dueState,
  UsageRuleSchema,
  deviceLiveState,
  inUseNow,
  resolveGatewayId,
  type UsageRule,
} from '@kestrel/model';
import { isMutedNow, mutedBy, type MuteScope } from './alert-mute';
import { effectiveStatus } from './gateway-status';
import { windowActive, type WindowRow } from './maintenance';
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
  | 'pmSchedule'
> &
  Partial<Pick<PrismaClient, 'deviceRoom' | 'org' | 'maintenanceWindow'>>;

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
  /** What is holding this room's alert notifications back (its own mute, its site's or the organisation's), or null. */
  mutedBy: MuteScope | null;
  /** When that mute ends. Null for one that stays until switched off. */
  mutedUntil: Date | null;
  /** Inside a maintenance window that covers the room, its site or the organisation right now. */
  inMaintenance: boolean;
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
    /** Maintenance checks past their due date, and due within their lead time. */
    pmOverdue: number;
    pmDueSoon: number;
  };
  sites: { id: string; name: string; muted: boolean; mutedUntil: Date | null; inMaintenance: boolean }[];
  /** The whole organisation's alerts are muted. */
  orgMuted: { muted: boolean; until: Date | null; inMaintenance: boolean };
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
    pmSchedules,
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
    db.pmSchedule.findMany({ where: { orgId, enabled: true } }),
  ]);
  const orgRow = db.org ? await db.org.findFirst({ where: { id: orgId } }) : null;
  const windows = db.maintenanceWindow
    ? ((await db.maintenanceWindow.findMany({ where: { orgId } })) as WindowRow[]).filter((w) =>
        windowActive(w, now),
      )
    : [];
  const orgInMaintenance = windows.some((w) => w.scope === 'org');
  const siteInMaintenance = (siteId: string) =>
    orgInMaintenance || windows.some((w) => w.scope === 'site' && w.scopeId === siteId);
  // Shared devices: a device is also in every room it is linked to, whatever site it is at.
  const links = db.deviceRoom ? await db.deviceRoom.findMany({ where: { orgId } }) : [];
  const deviceById = new Map(allDevices.map((d) => [d.id, d]));
  const homeRoomGateway = (roomId: string | null) =>
    roomId ? (allRooms.find((x) => x.id === roomId)?.gatewayId ?? null) : null;
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

  const siteById = new Map(sites.map((s) => [s.id, s]));
  const muteFor = (r: { alertsMuted: boolean; alertsMutedUntil: Date | null; siteId: string }) => {
    const by = mutedBy({ room: r, site: siteById.get(r.siteId), org: orgRow }, now);
    const row = by === 'room' ? r : by === 'site' ? siteById.get(r.siteId) : orgRow;
    return { mutedBy: by, mutedUntil: by ? (row?.alertsMutedUntil ?? null) : null };
  };
  const rows: EstateRoom[] = rooms.map((r) => {
    const linkedHere = links
      .filter((l) => l.roomId === r.id)
      .flatMap((l) => {
        const d = deviceById.get(l.deviceId);
        return d && d.roomId !== r.id ? [d] : [];
      });
    const linkedIds = new Set(linkedHere.map((d) => d.id));
    const own = [...devices.filter((d) => d.roomId === r.id), ...linkedHere];
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
        // A shared device is polled by its own home room's gateway, not the room that is looking at it.
        roomGatewayId: linkedIds.has(d.id) ? homeRoomGateway(d.roomId) : r.gatewayId,
        siteGatewayId: defaultGatewayAt.get(d.siteId) ?? null,
      });
      const gw = note(gwId);
      const state = deviceLiveState({
        kind: d.kind,
        online: d.online,
        gatewayOnline: gw?.status === 'online' || !!d.integrationId,
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

    const open = incidents.filter((i) => i.roomId === r.id || (i.roomIds ?? []).includes(r.id));
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
      ...muteFor(r),
      inMaintenance:
        siteInMaintenance(r.siteId) || windows.some((w) => w.scope === 'room' && w.scopeId === r.id),
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

  // Planned maintenance, for the rooms in view (a device check counts against its room).
  const pmStates = pmSchedules
    .filter((p) => {
      const kind = (p as { scope?: string }).scope ?? 'room';
      if (kind !== 'room') {
        // A schedule for several rooms, an area or a site counts when any of its rooms is in view.
        const m = p as { siteId?: string | null; areaId?: string | null; roomIds?: string[] };
        if (kind === 'rooms') return (m.roomIds ?? []).some((id) => roomIds.has(id));
        if (kind === 'site') return rooms.some((r) => r.siteId === m.siteId);
        const inside = new Set(m.areaId ? [m.areaId] : []);
        for (let grew = true; grew;) {
          grew = false;
          for (const a of allAreas)
            if (a.parentId && inside.has(a.parentId) && !inside.has(a.id)) {
              inside.add(a.id);
              grew = true;
            }
        }
        return rooms.some((r) => r.areaId !== null && inside.has(r.areaId));
      }
      const roomId = p.roomId ?? devices.find((d) => d.id === p.deviceId)?.roomId ?? null;
      return roomId !== null && roomIds.has(roomId);
    })
    .map((p) => dueState(p.nextDueOn, p.leadDays, now));

  return {
    kpis: {
      liveIncidents: incidents.filter((i) => !i.parentId).length,
      criticalIncidents: incidents.filter((i) => !i.parentId && i.severity === 'critical').length,
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
      pmOverdue: pmStates.filter((x) => x === 'overdue').length,
      pmDueSoon: pmStates.filter((x) => x === 'due_soon').length,
    },
    sites: sites.map((s) => ({
      id: s.id,
      name: s.name,
      muted: isMutedNow(s, now),
      mutedUntil: isMutedNow(s, now) ? s.alertsMutedUntil : null,
      inMaintenance: siteInMaintenance(s.id),
    })),
    orgMuted: {
      muted: isMutedNow(orgRow, now),
      until: isMutedNow(orgRow, now) ? (orgRow?.alertsMutedUntil ?? null) : null,
      inMaintenance: orgInMaintenance,
    },
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
