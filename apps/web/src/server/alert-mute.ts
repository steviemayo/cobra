import type { PrismaClient } from '@kestrel/db';

// Muting (a room, a site or the whole organisation) holds back alert notifications only. Incidents are
// still raised and shown in the portal, and tickets are unaffected. Functions take the database as a
// parameter.
export type MuteDb = Pick<PrismaClient, 'org' | 'site' | 'room' | 'gateway'>;
/** What a muted check needs. A database without the tables (older tests) has nothing muted. */
export type MuteCheckDb = Partial<MuteDb>;

export const MUTE_SCOPES = ['org', 'site', 'room'] as const;
export type MuteScope = (typeof MUTE_SCOPES)[number];

export interface MuteRow {
  alertsMuted: boolean;
  alertsMutedUntil: Date | null;
}

/** Whether a row is muted right now: switched on, and not past its end time when it has one. */
export function isMutedNow(row: MuteRow | null | undefined, now: Date): boolean {
  if (!row?.alertsMuted) return false;
  return row.alertsMutedUntil === null || row.alertsMutedUntil.getTime() > now.getTime();
}

/** What muted a room: the nearest of its own mute, its site's, or the organisation's. */
export function mutedBy(
  rows: { room?: MuteRow | null; site?: MuteRow | null; org?: MuteRow | null },
  now: Date,
): MuteScope | null {
  if (isMutedNow(rows.room, now)) return 'room';
  if (isMutedNow(rows.site, now)) return 'site';
  if (isMutedNow(rows.org, now)) return 'org';
  return null;
}

/**
 * Whether an incident's alerts are held back. An incident about rooms is muted when every room it
 * affects is muted (by itself, its site or the organisation); one about no room (a gateway going
 * silent) is muted by its site or the organisation.
 */
export async function incidentMuted(
  db: MuteCheckDb,
  incident: { orgId: string; roomId: string | null; roomIds?: string[]; gatewayId: string | null },
  now: Date,
): Promise<boolean> {
  const org = await db.org?.findFirst({ where: { id: incident.orgId } });
  if (isMutedNow(org, now)) return true;
  const roomIds = [
    ...new Set([...(incident.roomId ? [incident.roomId] : []), ...(incident.roomIds ?? [])]),
  ];
  if (roomIds.length > 0 && db.room) {
    const rooms = await db.room.findMany({ where: { id: { in: roomIds }, orgId: incident.orgId } });
    if (rooms.length === 0) return false;
    const sites =
      (await db.site?.findMany({
        where: { id: { in: [...new Set(rooms.map((r) => r.siteId))] }, orgId: incident.orgId },
      })) ?? [];
    const bySite = new Map(sites.map((s) => [s.id, s]));
    return rooms.every((r) => isMutedNow(r, now) || isMutedNow(bySite.get(r.siteId), now));
  }
  if (incident.gatewayId && db.gateway && db.site) {
    const gw = await db.gateway.findFirst({
      where: { id: incident.gatewayId, orgId: incident.orgId },
    });
    if (gw?.siteId) {
      const site = await db.site.findFirst({ where: { id: gw.siteId, orgId: incident.orgId } });
      return isMutedNow(site, now);
    }
  }
  return false;
}

type Result = { ok: true } | { ok: false; message: string };

/** Turns the mute on (until a time, or until switched off when `until` is null) or off. */
export async function setMute(
  db: MuteDb,
  input: {
    orgId: string;
    scope: MuteScope;
    scopeId?: string | null;
    muted: boolean;
    until?: Date | null;
  },
  now: Date,
): Promise<Result> {
  if (input.muted && input.until && input.until.getTime() <= now.getTime())
    return { ok: false, message: 'The end time has to be in the future' };
  const data = {
    alertsMuted: input.muted,
    alertsMutedUntil: input.muted ? (input.until ?? null) : null,
  };
  if (input.scope === 'org') {
    await db.org.update({ where: { id: input.orgId }, data });
    return { ok: true };
  }
  if (!input.scopeId) return { ok: false, message: 'Choose what to mute' };
  if (input.scope === 'site') {
    const r = await db.site.updateMany({ where: { id: input.scopeId, orgId: input.orgId }, data });
    return r.count ? { ok: true } : { ok: false, message: 'No such site' };
  }
  const r = await db.room.updateMany({ where: { id: input.scopeId, orgId: input.orgId }, data });
  return r.count ? { ok: true } : { ok: false, message: 'No such room' };
}
