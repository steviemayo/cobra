import type { PrismaClient } from '@kestrel/db';
import { viewAuditRows, type AuditViewDb } from './audit-view';

// The "since you were last here" recap shown after a login. Pure helpers (the gap rule, the audit
// filter, the KPIs) are separate from the one function that reads the database, so the rules can be
// tested without one.

/** Away at least this long and the next visit starts a new session with a recap. */
export const RECAP_GAP_MS = 30 * 60_000;
/** However long someone was away, the recap looks back no further than this. */
export const RECAP_MAX_LOOKBACK_MS = 30 * 24 * 3_600_000;
const ITEM_LIMIT = 5;

/** When the recap should start, or null when this is a first visit or a continuing session. */
export function recapSince(previous: Date | null, now: Date): Date | null {
  if (!previous) return null;
  if (now.getTime() - previous.getTime() < RECAP_GAP_MS) return null;
  return new Date(Math.max(previous.getTime(), now.getTime() - RECAP_MAX_LOOKBACK_MS));
}

// Audit entries worth telling someone about: changes to the estate and configuration. Commands,
// triggers, page views and the like are noise here.
const CHANGE_PREFIXES = [
  'room.',
  'device.',
  'site.',
  'config.',
  'gateway.',
  'member.',
  'invite.',
  'wall.',
  'ticket_rule.',
  'usage.',
  'pm.',
  'register.',
  'report.',
  'msp.',
  'license.',
  'billing.',
];
export const isChange = (action: string) => CHANGE_PREFIXES.some((p) => action.startsWith(p));

const VERBS: Record<string, string> = {
  create: 'created',
  create_many: 'created',
  update: 'updated',
  delete: 'deleted',
  deploy: 'deployed',
  copy: 'copied',
  claim: 'claimed',
  enroll: 'enrolled',
  role: 'role changed',
  set: 'changed',
};

/** "room.update" → "Room updated". Unknown verbs fall back to the raw word. */
export function describeChange(action: string): string {
  const [area = '', ...rest] = action.split('.');
  const verb = rest.join('.').replace(/_/g, ' ');
  const noun = area.replace(/_/g, ' ');
  const text = `${noun} ${VERBS[rest.join('.')] ?? verb}`.trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface RecapIncidentRow {
  id: string;
  title: string;
  severity: string;
  roomId: string | null;
  roomIds: string[];
  openedAt: Date;
  resolvedAt: Date | null;
  meetingsAffected: number;
}

export interface IncidentKpis {
  opened: number;
  resolved: number;
  stillOpen: number;
  critical: number;
  /** Mean minutes from opening to resolving, for incidents both opened and resolved in the window. */
  meanMinutesToResolve: number | null;
  roomsAffected: number;
  meetingsAffected: number;
}

export function incidentKpis(
  opened: RecapIncidentRow[],
  resolvedCount: number,
  stillOpen: { total: number; critical: number },
): IncidentKpis {
  const fixed = opened.filter((i) => i.resolvedAt);
  const rooms = new Set(opened.flatMap((i) => [...(i.roomId ? [i.roomId] : []), ...i.roomIds]));
  return {
    opened: opened.length,
    resolved: resolvedCount,
    stillOpen: stillOpen.total,
    critical: stillOpen.critical,
    meanMinutesToResolve: fixed.length
      ? Math.round(
          fixed.reduce((s, i) => s + (i.resolvedAt!.getTime() - i.openedAt.getTime()), 0) /
            fixed.length /
            60_000,
        )
      : null,
    roomsAffected: rooms.size,
    meetingsAffected: opened.reduce((s, i) => s + i.meetingsAffected, 0),
  };
}

export interface Recap {
  since: string;
  incidents: {
    kpis: IncidentKpis;
    items: {
      id: string;
      title: string;
      severity: string;
      roomName: string | null;
      resolved: boolean;
    }[];
  } | null;
  tickets: {
    opened: number;
    closed: number;
    escalated: number;
    /** Open or in progress and assigned to the person reading. */
    assignedToYou: number;
    items: { id: string; title: string; priority: string; roomName: string | null }[];
  } | null;
  changes: {
    total: number;
    deployments: number;
    people: { actor: string; count: number }[];
    items: { id: string; summary: string; actor: string; at: string }[];
  } | null;
}

export const recapIsEmpty = (r: Recap) =>
  !r.incidents?.kpis.opened &&
  !r.incidents?.kpis.resolved &&
  !r.incidents?.kpis.stillOpen &&
  !r.tickets?.opened &&
  !r.tickets?.closed &&
  !r.tickets?.assignedToYou &&
  !r.changes?.total;

export type RecapDb = Pick<PrismaClient, 'incident' | 'ticket' | 'auditLog' | 'room'> & AuditViewDb;

export async function buildRecap(
  db: RecapDb,
  args: { orgId: string; userId: string; since: Date; monitoring: boolean; seeChanges: boolean },
): Promise<Recap> {
  const { orgId, userId, since } = args;
  const afterSince = { gt: since };

  const [openedIncidents, resolvedCount, open, openCritical, tickets, closed, escalated, mine] =
    await Promise.all([
      args.monitoring
        ? db.incident.findMany({
            where: { orgId, parentId: null, openedAt: afterSince },
            select: {
              id: true,
              title: true,
              severity: true,
              roomId: true,
              roomIds: true,
              openedAt: true,
              resolvedAt: true,
              meetingsAffected: true,
            },
            orderBy: { openedAt: 'desc' },
            take: 500,
          })
        : [],
      args.monitoring
        ? db.incident.count({ where: { orgId, parentId: null, resolvedAt: afterSince } })
        : 0,
      args.monitoring ? db.incident.count({ where: { orgId, parentId: null, status: 'open' } }) : 0,
      args.monitoring
        ? db.incident.count({
            where: { orgId, parentId: null, status: 'open', severity: 'critical' },
          })
        : 0,
      db.ticket.findMany({
        where: { orgId, createdAt: afterSince },
        select: { id: true, title: true, priority: true, roomId: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      db.ticket.count({ where: { orgId, closedAt: afterSince } }),
      db.ticket.count({ where: { orgId, escalatedAt: afterSince } }),
      db.ticket.count({
        where: { orgId, assignedTo: userId, status: { in: ['open', 'in_progress'] } },
      }),
    ]);

  const audit = args.seeChanges
    ? await db.auditLog.findMany({
        where: { orgId, createdAt: afterSince, NOT: { actorId: userId } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      })
    : [];
  const changes = audit.filter((r) => isChange(r.action));
  const viewed = await viewAuditRows(db, orgId, changes);

  const shown = openedIncidents.slice(0, ITEM_LIMIT);
  const shownTickets = tickets.slice(0, ITEM_LIMIT);
  const roomIds = [
    ...new Set([...shown, ...shownTickets].flatMap((r) => (r.roomId ? [r.roomId] : []))),
  ];
  const rooms = roomIds.length
    ? await db.room.findMany({
        where: { orgId, id: { in: roomIds } },
        select: { id: true, name: true },
      })
    : [];
  const roomName = new Map(rooms.map((r) => [r.id, r.name]));

  const byActor = new Map<string, number>();
  for (const v of viewed) byActor.set(v.actor, (byActor.get(v.actor) ?? 0) + 1);

  return {
    since: since.toISOString(),
    incidents: args.monitoring
      ? {
          kpis: incidentKpis(openedIncidents, resolvedCount, {
            total: open,
            critical: openCritical,
          }),
          items: shown.map((i) => ({
            id: i.id,
            title: i.title,
            severity: i.severity,
            roomName: i.roomId ? (roomName.get(i.roomId) ?? null) : null,
            resolved: i.resolvedAt !== null,
          })),
        }
      : null,
    tickets: {
      opened: tickets.length,
      closed,
      escalated,
      assignedToYou: mine,
      items: shownTickets.map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        roomName: t.roomId ? (roomName.get(t.roomId) ?? null) : null,
      })),
    },
    changes: args.seeChanges
      ? {
          total: viewed.length,
          deployments: viewed.filter((v) => v.action === 'config.deploy').length,
          people: [...byActor]
            .map(([actor, count]) => ({ actor, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 3),
          items: viewed.slice(0, ITEM_LIMIT).map((v) => ({
            id: v.id,
            summary: describeChange(v.action),
            actor: v.actor,
            at: v.createdAt.toISOString(),
          })),
        }
      : null,
  };
}
