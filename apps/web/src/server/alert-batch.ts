import { incidentMuted } from './alert-mute';
import { dueNow } from './alert-rules';
import {
  buildMessage,
  channelRules,
  deliverAlerts,
  deliverToChannel,
  reaches,
  realSenders,
  type AlertDb,
  type AlertMessage,
  type IncidentRow,
  type Senders,
} from './alerts';
import { SEVERITY_RANK, type AlertJob, type Severity } from './monitoring';

// Problems that start together are told as one message. Alerts wait a few seconds to see what else
// is going wrong (shorter when something is critical), then problems that belong together go out as
// one digest: first a room's problems, then a site's. A problem on its own goes out exactly as it
// always did. Subnet outages are already one incident (incident-groups.ts); this sits on top.
//
// The wait is held in this server instance's memory, so it only joins alerts that land on the same
// instance (concurrent requests on Fluid Compute share one). Alerts on different instances are
// simply sent separately, never lost.

/** How long alerts are collected before sending: when something critical is among them, and otherwise. */
export const COLLECT_CRITICAL_MS = 2_000;
export const COLLECT_MS = 5_000;
/** Rooms with problems at one site, at or above which they are told as one site problem. */
export const SITE_GROUP_MIN_ROOMS = 3;
const MEMBERS_LISTED = 10;

export interface Group {
  kind: 'room' | 'site' | 'gateway';
  /** What the group is called in the message ("Boardroom", "Sydney HQ"). */
  label: string;
  incidents: IncidentRow[];
  rooms: number;
}

const maxSeverity = (rows: { severity: string }[]): Severity =>
  rows.reduce<Severity>(
    (best, r) =>
      SEVERITY_RANK[r.severity as Severity] > SEVERITY_RANK[best] ? (r.severity as Severity) : best,
    'info',
  );

/**
 * Sorts incidents (all of one organisation) into what is told together. Pure apart from the lookups:
 * incidents in the same room join; rooms at one site join once there are enough of them; what has
 * no room joins others on its gateway. Anything left alone comes back as a group of one.
 */
export async function planGroups(db: AlertDb, rows: IncidentRow[]): Promise<Group[]> {
  const roomIds = [...new Set(rows.map((r) => r.roomId).filter((x): x is string => !!x))];
  const rooms = roomIds.length ? await db.room.findMany({ where: { id: { in: roomIds } } }) : [];
  const roomInfo = new Map(rooms.map((r) => [r.id, { name: r.name, siteId: r.siteId }]));

  const byRoom = new Map<string, IncidentRow[]>();
  const byGateway = new Map<string, IncidentRow[]>();
  const alone: IncidentRow[] = [];
  for (const r of rows) {
    if (r.roomId && roomInfo.has(r.roomId))
      byRoom.set(r.roomId, [...(byRoom.get(r.roomId) ?? []), r]);
    else if (r.gatewayId) byGateway.set(r.gatewayId, [...(byGateway.get(r.gatewayId) ?? []), r]);
    else alone.push(r);
  }

  const groups: Group[] = [];
  // Rooms at one site, once enough of them have trouble.
  const bySite = new Map<string, string[]>();
  for (const id of byRoom.keys()) {
    const siteId = roomInfo.get(id)!.siteId;
    bySite.set(siteId, [...(bySite.get(siteId) ?? []), id]);
  }
  const taken = new Set<string>();
  for (const [siteId, ids] of bySite) {
    if (ids.length < SITE_GROUP_MIN_ROOMS) continue;
    const site = db.site ? await db.site.findFirst({ where: { id: siteId } }) : null;
    ids.forEach((id) => taken.add(id));
    groups.push({
      kind: 'site',
      label: site?.name ?? 'One site',
      incidents: ids.flatMap((id) => byRoom.get(id)!),
      rooms: ids.length,
    });
  }
  for (const [id, list] of byRoom) {
    if (taken.has(id)) continue;
    groups.push({ kind: 'room', label: roomInfo.get(id)!.name, incidents: list, rooms: 1 });
  }
  for (const list of byGateway.values())
    groups.push({ kind: 'gateway', label: 'One gateway', incidents: list, rooms: 0 });
  for (const r of alone) groups.push({ kind: 'gateway', label: '', incidents: [r], rooms: 0 });
  return groups;
}

/** One message for a group of several incidents. */
export function digestFor(
  group: Group,
  event: 'opened' | 'resolved',
  portalUrl: string | null,
): AlertMessage {
  const rows = [...group.incidents].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity as Severity] - SEVERITY_RANK[a.severity as Severity] ||
      a.openedAt.getTime() - b.openedAt.getTime(),
  );
  const n = rows.length;
  const first = rows[0]!;
  const shown = rows.slice(0, MEMBERS_LISTED).map((r) => `- ${r.title}`);
  if (n > MEMBERS_LISTED) shown.push(`- and ${n - MEMBERS_LISTED} more`);
  const title =
    group.kind === 'site'
      ? `${group.label}: ${n} problems in ${group.rooms} rooms`
      : group.kind === 'room'
        ? `${group.label}: ${n} problems`
        : `${n} problems at once`;
  return {
    event,
    incident: {
      id: first.id,
      kind: 'batch',
      severity: maxSeverity(rows),
      title,
      detail: shown.join('\n'),
      room: group.kind === 'room' ? group.label : null,
      openedAt: new Date(Math.min(...rows.map((r) => r.openedAt.getTime()))).toISOString(),
      resolvedAt:
        event === 'resolved'
          ? new Date(
              Math.max(...rows.map((r) => (r.resolvedAt ?? r.openedAt).getTime())),
            ).toISOString()
          : null,
    },
    portalUrl,
    batch: {
      count: n,
      incidents: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        severity: r.severity as Severity,
        title: r.title,
        room: null,
      })),
    },
  };
}

/** Sends one digest to every channel that should hear it, and records it against each member. */
async function sendDigest(
  db: AlertDb,
  group: Group,
  event: 'opened' | 'resolved',
  s: Senders,
  now: Date,
): Promise<void> {
  // Muted rooms, sites and organisations are left out of the digest.
  const heard = [];
  for (const i of group.incidents) if (!(await incidentMuted(db, i, now))) heard.push(i);
  if (heard.length === 0) return;
  group = { ...group, incidents: heard };
  const first = group.incidents[0]!;
  const base = await buildMessage(db, first, event, s.env, undefined, now);
  const msg = digestFor(group, event, base.portalUrl);
  const severity = { severity: msg.incident.severity };
  const ids = group.incidents.map((i) => i.id);
  const channels = await db.alertChannel.findMany({ where: { orgId: first.orgId, enabled: true } });
  for (const ch of channels) {
    if (!reaches(severity, ch)) continue;
    const rules = channelRules(ch);
    if (rules && event === 'opened') {
      // A channel with timing rules may hold it back; those go out one by one when they are due.
      const due = dueNow({
        rules,
        openedAt: new Date(msg.incident.openedAt),
        acknowledged: group.incidents.every((i) => i.acknowledgedAt !== null),
        sent: [],
        now,
      });
      if (due !== 'opened') continue;
    }
    if (rules && event === 'resolved') {
      const told = await db.alertDelivery.count({
        where: {
          channelId: ch.id,
          incidentId: { in: ids },
          status: { in: ['sent', 'batched'] },
          event: { in: ['opened', 'reminder'] },
        },
      });
      if (told === 0) continue;
    }
    const result = await deliverToChannel(db, ch, msg, first.id, s, now);
    if (result.status === 'sent' && ids.length > 1)
      await db.alertDelivery.createMany({
        data: ids.slice(1).map((incidentId) => ({
          orgId: ch.orgId,
          channelId: ch.id,
          incidentId,
          event,
          status: 'batched',
          error: null,
          at: now,
        })),
      });
  }
}

/** Sends what a monitoring pass produced, with problems that belong together told as one. */
export async function deliverBatched(
  db: AlertDb,
  jobs: AlertJob[],
  s: Senders,
  now = new Date(),
): Promise<void> {
  const ids = [...new Set(jobs.map((j) => j.incidentId))];
  const rows = ids.length ? await db.incident.findMany({ where: { id: { in: ids } } }) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const singles: AlertJob[] = [];
  for (const event of ['opened', 'resolved'] as const) {
    const mine = [...new Set(jobs.filter((j) => j.event === event).map((j) => j.incidentId))]
      .map((id) => byId.get(id))
      .filter((r): r is IncidentRow => !!r);
    const orgs = [...new Set(mine.map((r) => r.orgId))];
    for (const orgId of orgs) {
      try {
        const groups = await planGroups(
          db,
          mine.filter((r) => r.orgId === orgId),
        );
        for (const g of groups) {
          if (g.incidents.length === 1) singles.push({ incidentId: g.incidents[0]!.id, event });
          else
            await sendDigest(db, g, event, s, now).catch((e: unknown) => {
              console.error('[alerts] digest failed', e);
            });
        }
      } catch (e) {
        // Grouping is only ever extra: if it fails the alerts go out one by one.
        console.error('[alerts] could not group alerts', e);
        for (const r of mine.filter((m) => m.orgId === orgId))
          singles.push({ incidentId: r.id, event });
      }
    }
  }
  // Reminders and anything else pass straight through.
  for (const j of jobs) if (j.event !== 'opened' && j.event !== 'resolved') singles.push(j);
  if (singles.length) await deliverAlerts(db, singles, s, now);
}

// ---- The collecting window -------------------------------------------------------------------------

interface Pending {
  jobs: AlertJob[];
  due: number;
  timer: ReturnType<typeof setTimeout>;
  waiters: (() => void)[];
  db: AlertDb;
  s: Senders | undefined;
}
let pending: Pending | null = null;

/**
 * Takes the alert jobs one request produced and returns when they have been sent. Jobs from
 * requests that arrive meanwhile on this instance join them. Never throws.
 */
export function queueAlerts(
  db: AlertDb,
  jobs: AlertJob[],
  s?: Senders,
  windows: { critical: number; normal: number } = {
    critical: COLLECT_CRITICAL_MS,
    normal: COLLECT_MS,
  },
): Promise<void> {
  if (jobs.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    void (async () => {
      let critical = false;
      try {
        const rows = await db.incident.findMany({
          where: { id: { in: jobs.map((j) => j.incidentId) } },
        });
        critical = rows.some((r) => r.severity === 'critical');
      } catch {
        // Unknown severity: use the longer wait.
      }
      const due = Date.now() + (critical ? windows.critical : windows.normal);
      if (pending) {
        pending.jobs.push(...jobs);
        pending.waiters.push(resolve);
        if (due < pending.due) {
          clearTimeout(pending.timer);
          pending.due = due;
          pending.timer = setTimeout(flush, Math.max(0, due - Date.now()));
        }
        return;
      }
      pending = {
        jobs: [...jobs],
        due,
        timer: setTimeout(flush, Math.max(0, due - Date.now())),
        waiters: [resolve],
        db,
        s,
      };
    })();
  });
}

function flush() {
  const batch = pending;
  pending = null;
  if (!batch) return;
  void (async () => {
    try {
      await deliverBatched(batch.db, batch.jobs, batch.s ?? realSenders());
    } catch (e) {
      console.error('[alerts] batched delivery failed', e);
    } finally {
      for (const w of batch.waiters) w();
    }
  })();
}
