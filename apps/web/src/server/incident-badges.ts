import { SEVERITY_RANK, type Severity } from './monitoring';

// What the app's menu badges and toasts need to know about open incidents, in one small answer:
// how many need someone, how bad, which rooms they touch, and the newest few to announce. An
// incident someone has acknowledged is being looked after, so it no longer badges or announces.

export interface BadgeRow {
  id: string;
  kind: string;
  severity: string;
  title: string;
  roomId: string | null;
  roomIds: string[];
  /** Set for a device that is part of a group outage: the group is counted, the device is not. */
  parentId: string | null;
  openedAt: Date;
  acknowledgedAt: Date | null;
}

export interface IncidentBadges {
  /** Open, unacknowledged incidents, a group outage counting once. */
  open: number;
  critical: number;
  /** Rooms with trouble: every open incident that touches them, devices of a group included. */
  rooms: { roomId: string; count: number; severity: Severity }[];
  /** The newest of them, for toasts. */
  recent: {
    id: string;
    kind: string;
    severity: Severity;
    title: string;
    roomId: string | null;
    roomName: string | null;
    openedAt: string;
  }[];
}

export const RECENT_LIMIT = 30;

const worse = (a: Severity, b: Severity) => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a);

export function summariseBadges(rows: BadgeRow[], roomNames: Map<string, string>): IncidentBadges {
  const live = rows.filter((r) => r.acknowledgedAt === null);
  const top = live.filter((r) => !r.parentId);
  const byRoom = new Map<string, { count: number; severity: Severity }>();
  for (const r of live) {
    const sev = r.severity as Severity;
    for (const id of new Set([...(r.roomId ? [r.roomId] : []), ...r.roomIds])) {
      const cur = byRoom.get(id);
      byRoom.set(id, {
        count: (cur?.count ?? 0) + 1,
        severity: cur ? worse(cur.severity, sev) : sev,
      });
    }
  }
  return {
    open: top.length,
    critical: top.filter((r) => r.severity === 'critical').length,
    rooms: [...byRoom].map(([roomId, v]) => ({ roomId, ...v })),
    recent: [...top]
      .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())
      .slice(0, RECENT_LIMIT)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        severity: r.severity as Severity,
        title: r.title,
        roomId: r.roomId,
        roomName: r.roomId ? (roomNames.get(r.roomId) ?? null) : null,
        openedAt: r.openedAt.toISOString(),
      })),
  };
}
