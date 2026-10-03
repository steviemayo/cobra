import type { PrismaClient } from '@kestrel/db';
import type { Severity } from './monitoring';

// The daily briefing: where the organisation (or one site) stands, and a short hit list of the
// things most worth someone's attention today. Scoring and wording are pure so they can be tested
// without a database; `buildBriefing` is the one function that reads it.

export const HITLIST_SIZE = 5;
const HOUR_MS = 3_600_000;

export type BriefingDb = Pick<PrismaClient, 'incident' | 'ticket' | 'room' | 'gateway'>;

export interface HitCandidate {
  kind: 'incident' | 'ticket';
  id: string;
  title: string;
  room: string | null;
  score: number;
  /** Plain-language reasons it ranks here. */
  why: string[];
}

export interface BriefingIncident {
  id: string;
  title: string;
  severity: string;
  roomId: string | null;
  openedAt: Date;
  acknowledgedAt: Date | null;
  occurrences: number;
  meetingsAffected: number;
}

export interface BriefingTicket {
  id: string;
  title: string;
  priority: string;
  roomId: string | null;
  createdAt: Date;
  escalatedAt: Date | null;
  assignedTo: string | null;
  staffAssignee: string | null;
}

const SEVERITY_SCORE: Record<string, number> = { critical: 100, warning: 50, info: 10 };
const PRIORITY_SCORE: Record<string, number> = { urgent: 80, high: 50, normal: 15, low: 5 };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const age = (ms: number) => {
  const h = Math.floor(ms / HOUR_MS);
  return h < 48 ? `${Math.max(h, 1)}h` : `${Math.floor(h / 24)} days`;
};

export function scoreIncident(
  i: BriefingIncident,
  now: Date,
  roomName: string | null,
): HitCandidate {
  const open = now.getTime() - i.openedAt.getTime();
  const why = [i.severity];
  let score = SEVERITY_SCORE[i.severity] ?? 10;
  if (i.meetingsAffected > 0) {
    score += Math.min(i.meetingsAffected, 10) * 10;
    why.push(`${plural(i.meetingsAffected, 'meeting')} affected`);
  }
  if (i.occurrences > 1) {
    score += Math.min(i.occurrences, 5) * 5;
    why.push(`came back ${plural(i.occurrences - 1, 'time')}`);
  }
  score += Math.min(open / HOUR_MS, 48) / 2;
  why.push(`open ${age(open)}`);
  if (!i.acknowledgedAt) {
    score += 15;
    why.push('nobody on it yet');
  }
  return { kind: 'incident', id: i.id, title: i.title, room: roomName, score, why };
}

export function scoreTicket(t: BriefingTicket, now: Date, roomName: string | null): HitCandidate {
  const open = now.getTime() - t.createdAt.getTime();
  const why = [`${t.priority} priority`];
  let score = PRIORITY_SCORE[t.priority] ?? 15;
  if (t.escalatedAt) {
    score += 20;
    why.push('escalated');
  }
  if (!t.assignedTo && !t.staffAssignee) {
    score += 10;
    why.push('unassigned');
  }
  score += Math.min(open / (24 * HOUR_MS), 10) * 3;
  why.push(`open ${age(open)}`);
  return { kind: 'ticket', id: t.id, title: t.title, room: roomName, score, why };
}

export interface Briefing {
  scope: string;
  status: {
    rooms: number;
    roomsWithTrouble: number;
    openIncidents: number;
    critical: number;
    unacknowledged: number;
    meetingsAffected: number;
    openTickets: number;
    urgentTickets: number;
    unassignedTickets: number;
  };
  hitlist: HitCandidate[];
}

/** Pure: figures and ranking from already-loaded rows. */
export function summariseBriefing(
  scope: string,
  rows: {
    rooms: { id: string; name: string }[];
    incidents: BriefingIncident[];
    tickets: BriefingTicket[];
  },
  now: Date,
): Briefing {
  const names = new Map(rows.rooms.map((r) => [r.id, r.name]));
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null);
  const troubled = new Set(rows.incidents.flatMap((i) => (i.roomId ? [i.roomId] : [])));
  const hits = [
    ...rows.incidents.map((i) => scoreIncident(i, now, nameOf(i.roomId))),
    ...rows.tickets.map((t) => scoreTicket(t, now, nameOf(t.roomId))),
  ]
    .sort((a, b) => b.score - a.score)
    .slice(0, HITLIST_SIZE);
  return {
    scope,
    status: {
      rooms: rows.rooms.length,
      roomsWithTrouble: troubled.size,
      openIncidents: rows.incidents.length,
      critical: rows.incidents.filter((i) => i.severity === 'critical').length,
      unacknowledged: rows.incidents.filter((i) => !i.acknowledgedAt).length,
      meetingsAffected: rows.incidents.reduce((s, i) => s + i.meetingsAffected, 0),
      openTickets: rows.tickets.length,
      urgentTickets: rows.tickets.filter((t) => t.priority === 'urgent' || t.priority === 'high')
        .length,
      unassignedTickets: rows.tickets.filter((t) => !t.assignedTo && !t.staffAssignee).length,
    },
    hitlist: hits,
  };
}

/** The worst thing going, for a headline: critical wins, then warning, then all quiet. */
export function briefingSeverity(b: Briefing): Severity {
  if (b.status.critical > 0) return 'critical';
  return b.status.openIncidents > 0 ? 'warning' : 'info';
}

/** A short headline (fits a text message) and a longer body. */
export function formatBriefing(b: Briefing): { title: string; body: string } {
  const s = b.status;
  const title =
    s.openIncidents === 0 && s.openTickets === 0
      ? `Daily briefing, ${b.scope}: all quiet`
      : `Daily briefing, ${b.scope}: ${plural(s.openIncidents, 'open incident')}${
          s.critical ? ` (${s.critical} critical)` : ''
        }, ${plural(s.openTickets, 'open ticket')}`;
  const lines = [
    `${plural(s.rooms, 'room')}, ${s.roomsWithTrouble} with trouble.`,
    `Incidents: ${s.openIncidents} open, ${s.critical} critical, ${s.unacknowledged} unacknowledged${
      s.meetingsAffected ? `, ${plural(s.meetingsAffected, 'meeting')} affected` : ''
    }.`,
    `Tickets: ${s.openTickets} open, ${s.urgentTickets} high or urgent, ${s.unassignedTickets} unassigned.`,
  ];
  if (b.hitlist.length > 0) {
    lines.push('', 'Focus on today:');
    b.hitlist.forEach((h, n) =>
      lines.push(
        `${n + 1}. ${h.kind === 'ticket' ? 'Ticket: ' : ''}${h.title}${h.room ? ` (${h.room})` : ''} — ${h.why.join(', ')}`,
      ),
    );
  }
  return { title, body: lines.join('\n') };
}

/** Reads what the briefing needs for the whole organisation, or one site, and ranks it. */
export async function buildBriefing(
  db: BriefingDb,
  args: { orgId: string; siteId: string | null; scopeName: string; now: Date },
): Promise<Briefing> {
  const { orgId, siteId, now } = args;
  const rooms = await db.room.findMany({
    where: { orgId, ...(siteId ? { siteId } : {}) },
    select: { id: true, name: true },
  });
  const roomIds = rooms.map((r) => r.id);
  const gateways = siteId
    ? await db.gateway.findMany({ where: { orgId, siteId }, select: { id: true } })
    : [];
  const incidents = await db.incident.findMany({
    where: {
      orgId,
      status: 'open',
      parentId: null,
      ...(siteId
        ? {
            OR: [
              { roomId: { in: roomIds } },
              { roomIds: { hasSome: roomIds } },
              { roomId: null, gatewayId: { in: gateways.map((g) => g.id) } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      title: true,
      severity: true,
      roomId: true,
      openedAt: true,
      acknowledgedAt: true,
      occurrences: true,
      meetingsAffected: true,
    },
    take: 500,
  });
  const tickets = await db.ticket.findMany({
    where: {
      orgId,
      status: { in: ['open', 'in_progress'] },
      ...(siteId ? { roomId: { in: roomIds } } : {}),
    },
    select: {
      id: true,
      title: true,
      priority: true,
      roomId: true,
      createdAt: true,
      escalatedAt: true,
      assignedTo: true,
      staffAssignee: true,
    },
    take: 500,
  });
  return summariseBriefing(args.scopeName, { rooms, incidents, tickets }, now);
}
