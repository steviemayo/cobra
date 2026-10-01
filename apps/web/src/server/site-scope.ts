import { mspRoute } from '@kestrel/model';

// Site-limited access. A service provider connected to only some of a customer's sites sees and
// works with those sites and nothing else. `null` means the whole organisation (members, whole-org
// providers, staff sessions); a list means only those sites.
//
// This is deny by default: procedures are refused for a site-limited provider unless they declare
// `meta: SITE_SCOPED` and apply the filters below. A new procedure is therefore closed to
// site-limited providers until someone makes it site-aware on purpose.
export type SiteScope = string[] | null;

/** Put on a procedure's meta once it filters by the caller's site scope. */
export const SITE_SCOPED = { siteScoped: true } as const;

export const inScope = (scope: SiteScope, siteId: string): boolean =>
  scope === null || scope.includes(siteId);

/** A Prisma `where` fragment for rows that have a `siteId`. */
export const siteFilter = (scope: SiteScope): { siteId?: { in: string[] } } =>
  scope === null ? {} : { siteId: { in: scope } };

/** The ids of the rooms whose site is in scope. */
export function roomIdsInScope(
  rooms: { id: string; siteId: string }[],
  scope: SiteScope,
): Set<string> {
  return new Set(rooms.filter((r) => inScope(scope, r.siteId)).map((r) => r.id));
}

/**
 * Whether a ticket is visible. Whole-organisation access sees everything. A site-limited provider
 * sees tickets about rooms at its sites, and tickets routed to it (which the customer chose to
 * send it, whatever the room).
 */
export function ticketVisible(
  ticket: { roomId: string | null; routedTo: string },
  scope: SiteScope,
  roomIds: Set<string>,
  mspOrgId: string | null,
): boolean {
  if (scope === null) return true;
  if (mspOrgId && ticket.routedTo === mspRoute(mspOrgId)) return true;
  return ticket.roomId !== null && roomIds.has(ticket.roomId);
}

/** An incident is about a room or (for a silent gateway) a gateway; either must be in scope. */
export function incidentVisible(
  incident: { roomId: string | null; gatewayId: string | null; roomIds?: string[] | null },
  scope: SiteScope,
  roomIds: Set<string>,
  gatewayIds: Set<string>,
): boolean {
  if (scope === null) return true;
  // An incident that also affects other rooms (a shared device) is visible from any of them.
  if (incident.roomId)
    return roomIds.has(incident.roomId) || (incident.roomIds ?? []).some((r) => roomIds.has(r));
  return incident.gatewayId !== null && gatewayIds.has(incident.gatewayId);
}
