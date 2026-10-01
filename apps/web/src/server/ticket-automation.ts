import type { PrismaClient } from '@kestrel/db';

import { SEVERITY_RANK, type Severity } from './monitoring';
import { deviceOfSubject } from './maintenance';

// Turning incidents into tickets by rule (docs/pivot-monitoring.md, "Support"): the first matching
// rule for an organisation decides the priority and who it goes to; a fault that spans a gateway or
// a room becomes one ticket, not one per device; and a ticket nobody has answered can move up.
export type AutomationDb = Pick<
  PrismaClient,
  'ticketRule' | 'incident' | 'ticket' | 'ticketComment' | 'room' | 'mspGrant'
>;

export const PRIORITY_ORDER = ['low', 'normal', 'high', 'urgent'] as const;
export const ROUTES_BASE = ['org', 'kestrel'] as const;
const MINUTE = 60_000;
type Result<T = { id: string }> = { ok: true; value: T } | { ok: false; message: string };
const bad = (message: string): { ok: false; message: string } => ({ ok: false, message });

export interface RuleInput {
  name: string;
  enabled?: boolean;
  sortOrder?: number;
  kinds?: string[];
  minSeverity?: string;
  siteIds?: string[];
  afterMinutes?: number;
  priority?: string;
  routeTo?: string;
  escalateAfterMinutes?: number;
  escalatePriority?: string;
  escalateTo?: string;
}

async function checkRoute(db: AutomationDb, orgId: string, route: string): Promise<string | null> {
  if ((ROUTES_BASE as readonly string[]).includes(route)) return null;
  const m = /^msp:([0-9a-f-]{36})$/.exec(route);
  if (!m) return 'That is not somewhere a ticket can go';
  const grant = await db.mspGrant.findFirst({
    where: { mspOrgId: m[1]!, customerOrgId: orgId, status: 'active' },
  });
  return grant ? null : 'That service provider is not connected to this organisation';
}

async function checkRule(db: AutomationDb, orgId: string, r: RuleInput): Promise<string | null> {
  if (r.priority && !PRIORITY_ORDER.includes(r.priority as never)) return 'Unknown priority';
  if (r.escalatePriority && !PRIORITY_ORDER.includes(r.escalatePriority as never))
    return 'Unknown priority';
  if (r.minSeverity && !(r.minSeverity in SEVERITY_RANK)) return 'Unknown severity';
  if (r.routeTo) {
    const e = await checkRoute(db, orgId, r.routeTo);
    if (e) return e;
  }
  if (r.escalateTo && (r.escalateAfterMinutes ?? 0) > 0) {
    const e = await checkRoute(db, orgId, r.escalateTo);
    if (e) return e;
  }
  return null;
}

export async function createRule(
  db: AutomationDb,
  orgId: string,
  input: RuleInput,
): Promise<Result> {
  const problem = await checkRule(db, orgId, input);
  if (problem) return bad(problem);
  const last = await db.ticketRule.findMany({ where: { orgId }, orderBy: { sortOrder: 'desc' } });
  const row = await db.ticketRule.create({
    data: {
      orgId,
      name: input.name,
      enabled: input.enabled ?? true,
      sortOrder: input.sortOrder ?? (last[0]?.sortOrder ?? 0) + 1,
      kinds: input.kinds ?? [],
      minSeverity: input.minSeverity ?? 'warning',
      siteIds: input.siteIds ?? [],
      afterMinutes: input.afterMinutes ?? 10,
      priority: input.priority ?? 'normal',
      routeTo: input.routeTo ?? 'org',
      escalateAfterMinutes: input.escalateAfterMinutes ?? 0,
      escalatePriority: input.escalatePriority ?? 'high',
      escalateTo: input.escalateTo ?? 'kestrel',
    },
  });
  return { ok: true, value: { id: row.id } };
}

export async function updateRule(
  db: AutomationDb,
  orgId: string,
  id: string,
  input: Partial<RuleInput>,
): Promise<Result> {
  const row = await db.ticketRule.findFirst({ where: { id, orgId } });
  if (!row) return bad('No such rule');
  const problem = await checkRule(db, orgId, input as RuleInput);
  if (problem) return bad(problem);
  await db.ticketRule.update({ where: { id }, data: input });
  return { ok: true, value: { id } };
}

export async function deleteRule(db: AutomationDb, orgId: string, id: string): Promise<Result> {
  const row = await db.ticketRule.findFirst({ where: { id, orgId } });
  if (!row) return bad('No such rule');
  await db.ticketRule.delete({ where: { id } });
  return { ok: true, value: { id } };
}

type IncidentRow = NonNullable<Awaited<ReturnType<AutomationDb['incident']['findFirst']>>>;
type RuleRow = NonNullable<Awaited<ReturnType<AutomationDb['ticketRule']['findFirst']>>>;

const ruleMatches = (r: RuleRow, i: IncidentRow, siteId: string | null): boolean =>
  r.enabled &&
  (r.kinds.length === 0 || r.kinds.includes(i.kind)) &&
  (SEVERITY_RANK[i.severity as Severity] ?? 0) >= (SEVERITY_RANK[r.minSeverity as Severity] ?? 0) &&
  (r.siteIds.length === 0 || (siteId !== null && r.siteIds.includes(siteId)));

export interface AutoTicketResult {
  created: { ticketId: string; incidentId: string }[];
  grouped: number;
  escalated: string[];
}

/**
 * One pass: raises tickets for incidents that a rule wants and that have been open long enough,
 * then escalates tickets a rule made that nobody has answered. Safe to run as often as you like.
 * `onTicket` is told about each new or changed ticket (to mirror it to a service desk).
 */
export async function autoTicket(
  db: AutomationDb,
  now = new Date(),
  onTicket?: (
    ticket: NonNullable<Awaited<ReturnType<AutomationDb['ticket']['findFirst']>>>,
    event: 'ticket.created' | 'ticket.updated',
  ) => Promise<void>,
): Promise<AutoTicketResult> {
  const out: AutoTicketResult = { created: [], grouped: 0, escalated: [] };
  const rules = (await db.ticketRule.findMany({ orderBy: { sortOrder: 'asc' } })).filter(
    (r) => r.enabled,
  );
  if (rules.length === 0) return out;
  const orgs = [...new Set(rules.map((r) => r.orgId))];
  for (const orgId of orgs) {
    const orgRules = rules.filter((r) => r.orgId === orgId);
    const open = await db.incident.findMany({ where: { orgId, status: 'open' } });
    const tickets = await db.ticket.findMany({ where: { orgId } });
    const linked = new Set(tickets.map((t) => t.incidentId).filter((x): x is string => !!x));
    for (const inc of open) {
      if (linked.has(inc.id)) continue;
      const room = inc.roomId
        ? await db.room.findFirst({ where: { id: inc.roomId, orgId } })
        : null;
      const rule = orgRules.find((r) => ruleMatches(r, inc, room?.siteId ?? null));
      if (!rule) continue;
      if (now.getTime() - inc.openedAt.getTime() < rule.afterMinutes * MINUTE) continue;
      // One ticket for a gateway outage, not one per device behind it.
      if (
        inc.gatewayId &&
        inc.kind === 'device_offline' &&
        open.some((o) => o.kind === 'gateway_offline' && o.gatewayId === inc.gatewayId)
      ) {
        out.grouped++;
        continue;
      }
      // And one ticket per room while it is open: a second fault in the room is added to it.
      const sameRoom = inc.roomId
        ? tickets.find(
            (t) =>
              t.roomId === inc.roomId && t.ruleId && ['open', 'in_progress'].includes(t.status),
          )
        : undefined;
      if (sameRoom) {
        const marker = `[incident:${inc.id}]`;
        const seen = await db.ticketComment.findFirst({
          where: { ticketId: sameRoom.id, body: { contains: marker } },
        });
        if (!seen) {
          await db.ticketComment.create({
            data: {
              orgId,
              ticketId: sameRoom.id,
              body: `Also: ${inc.title}. ${inc.detail ?? ''} ${marker}`.trim(),
              visibility: 'internal',
              fromStaff: false,
              createdAt: now,
            },
          });
          out.grouped++;
        }
        continue;
      }
      let route = rule.routeTo;
      if ((await checkRoute(db, orgId, route)) !== null) route = 'org';
      const ticket = await db.ticket.create({
        data: {
          orgId,
          roomId: inc.roomId,
          incidentId: inc.id,
          deviceId: deviceOfSubject(inc.subject),
          title: inc.title,
          body: inc.detail ?? inc.title,
          status: 'open',
          priority: rule.priority,
          routedTo: route,
          ruleId: rule.id,
          ruleEscalated: false,
          ...(route === 'kestrel' ? { escalatedAt: now } : {}),
          createdAt: now,
        },
      });
      tickets.push(ticket);
      out.created.push({ ticketId: ticket.id, incidentId: inc.id });
      await onTicket?.(ticket, 'ticket.created');
    }

    // Escalate what nobody has answered.
    for (const t of tickets) {
      if (!t.ruleId || t.ruleEscalated || t.status !== 'open') continue;
      const rule = orgRules.find((r) => r.id === t.ruleId);
      if (!rule || rule.escalateAfterMinutes <= 0) continue;
      if (now.getTime() - t.createdAt.getTime() < rule.escalateAfterMinutes * MINUTE) continue;
      const replies = await db.ticketComment.findMany({ where: { ticketId: t.id } });
      if (replies.some((c) => !c.body.startsWith('Escalated automatically'))) continue;
      const better =
        PRIORITY_ORDER.indexOf(rule.escalatePriority as never) >
        PRIORITY_ORDER.indexOf(t.priority as never)
          ? rule.escalatePriority
          : t.priority;
      const route =
        (await checkRoute(db, orgId, rule.escalateTo)) === null ? rule.escalateTo : t.routedTo;
      const updated = await db.ticket.update({
        where: { id: t.id },
        data: {
          priority: better,
          routedTo: route,
          ruleEscalated: true,
          ...(route === 'kestrel' && t.routedTo !== 'kestrel' ? { escalatedAt: now } : {}),
        },
      });
      await db.ticketComment.create({
        data: {
          orgId,
          ticketId: t.id,
          body: `Escalated automatically: no reply after ${rule.escalateAfterMinutes} minutes.`,
          visibility: 'internal',
          fromStaff: false,
          createdAt: now,
        },
      });
      out.escalated.push(t.id);
      await onTicket?.(updated, 'ticket.updated');
    }
  }
  return out;
}
