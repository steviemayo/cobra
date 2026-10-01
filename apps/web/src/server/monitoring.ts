import { Prisma, type PrismaClient } from '@kestrel/db';
import type { RoomReport } from '@kestrel/model';
import { formatInZone } from '../lib/time';
import { getEntitlements } from './billing';
import { effectiveStatus } from './gateway-status';
import { siteTimezone } from './site-zone';
import { deviceOfSubject, inMaintenance, type MaintenanceDb } from './maintenance';
import { mirrorTicket, type ItsmDb } from './itsm-service';
import { pinnedFetch, resolveAll } from './outbound';
import { autoTicket, type AutomationDb } from './ticket-automation';
import { meetingPressure } from './room-schedule';

// Turns what gateways report into device status and incidents. Functions take the database as a
// parameter so they can be tested without one. They return alert jobs instead of sending anything,
// so a slow webhook can never hold up a heartbeat.
export type MonitoringDb = Pick<
  PrismaClient,
  'deviceStatus' | 'incident' | 'room' | 'gateway' | 'remoteCommand' | 'orgBilling' | 'org'
> &
  Partial<Pick<PrismaClient, 'maintenanceWindow' | 'site' | 'roomSchedule'>>;

export type Severity = 'info' | 'warning' | 'critical';
export type IncidentKind =
  | 'device_offline'
  | 'gateway_offline'
  | 'room_fault'
  | 'deploy_failed'
  | 'point_alert'
  | 'config_drift'
  | 'config_enforce_failed'
  | 'pm_overdue'
  | 'latency_high'
  | 'network_degraded'
  | 'group_outage';

export interface AlertJob {
  incidentId: string;
  event: 'opened' | 'resolved';
}

/** A device must stay offline this long (about two heartbeats) before it becomes an incident. */
export const DEVICE_GRACE_MS = 45_000;
/** A problem that comes back within this long of being resolved reopens the same incident, quietly. */
export const FLAP_WINDOW_MS = 5 * 60_000;
export const COMMAND_PENDING_EXPIRY_MS = 5 * 60_000;
export const COMMAND_SENT_EXPIRY_MS = 10 * 60_000;

/** Problems that can spoil a meeting. Housekeeping kinds (overdue checks, drift, failed deploys) never count. */
const MEETING_KINDS: IncidentKind[] = [
  'device_offline',
  'room_fault',
  'point_alert',
  'latency_high',
  'network_degraded',
];
const RAISED: Record<Severity, Severity> = {
  info: 'warning',
  warning: 'critical',
  critical: 'critical',
};

interface NewIncident {
  orgId: string;
  roomId?: string | null;
  /** Other rooms the same problem affects (a shared device serves several). */
  roomIds?: string[];
  gatewayId?: string | null;
  /** The site, for a problem that is about the site rather than a room (so its maintenance windows apply). */
  siteId?: string | null;
  kind: IncidentKind;
  subject: string;
  severity: Severity;
  title: string;
  detail?: string | null;
}

export async function openIncident(
  db: MonitoringDb,
  input: NewIncident,
  now: Date,
): Promise<AlertJob | null> {
  const key = { orgId: input.orgId, kind: input.kind, subject: input.subject };
  const open = await db.incident.findFirst({ where: { ...key, status: 'open' } });
  if (open) {
    await db.incident.update({
      where: { id: open.id },
      data: {
        lastSeenAt: now,
        title: input.title,
        detail: input.detail ?? null,
        ...(input.roomIds ? { roomIds: input.roomIds } : {}),
      },
    });
    return null;
  }
  const recent = await db.incident.findFirst({
    where: {
      ...key,
      status: 'resolved',
      resolvedAt: { gte: new Date(now.getTime() - FLAP_WINDOW_MS) },
    },
    orderBy: { resolvedAt: 'desc' },
  });
  if (recent) {
    await db.incident.update({
      where: { id: recent.id },
      data: {
        status: 'open',
        resolvedAt: null,
        lastSeenAt: now,
        occurrences: recent.occurrences + 1,
        title: input.title,
        detail: input.detail ?? null,
        ...(input.roomIds ? { roomIds: input.roomIds } : {}),
      },
    });
    return null;
  }
  // Inside a maintenance window nothing new is raised: no incident, no alert, no ticket.
  if (
    await inMaintenance(
      db as unknown as MaintenanceDb,
      input.orgId,
      { roomId: input.roomId, deviceId: deviceOfSubject(input.subject), siteId: input.siteId },
      now,
    )
  )
    return null;
  // A problem that opens while a meeting is on, or about to start, is worse than the same problem at
  // night: mark it and raise its severity one step. The calendar is only extra context, so any trouble
  // reading it leaves the incident as it was.
  let meetingsAffected = 0;
  if (MEETING_KINDS.includes(input.kind)) {
    const rooms = [...(input.roomId ? [input.roomId] : []), ...(input.roomIds ?? [])];
    try {
      meetingsAffected = await meetingPressure(db, input.orgId, rooms, now);
    } catch (e) {
      console.error('[monitoring] could not check meetings for a new incident', e);
    }
  }
  const severity = meetingsAffected > 0 ? RAISED[input.severity] : input.severity;
  const created = await db.incident.create({
    data: {
      orgId: input.orgId,
      roomId: input.roomId ?? null,
      roomIds: input.roomIds ?? [],
      gatewayId: input.gatewayId ?? null,
      kind: input.kind,
      subject: input.subject,
      severity,
      meetingsAffected,
      severityRaised: severity !== input.severity,
      status: 'open',
      title: input.title,
      detail: input.detail ?? null,
      openedAt: now,
      lastSeenAt: now,
      occurrences: 1,
      alerted: true,
    },
  });
  return { incidentId: created.id, event: 'opened' };
}

export async function resolveIncident(
  db: MonitoringDb,
  key: { orgId: string; kind: IncidentKind; subject: string },
  now: Date,
): Promise<AlertJob | null> {
  const open = await db.incident.findFirst({ where: { ...key, status: 'open' } });
  if (!open) return null;
  await db.incident.update({
    where: { id: open.id },
    data: { status: 'resolved', resolvedAt: now },
  });
  return open.alerted ? { incidentId: open.id, event: 'resolved' } : null;
}

/** Applies one heartbeat's room reports for a gateway: device status first, then incidents. */
export async function recordReports(
  db: MonitoringDb,
  gw: { id: string; orgId: string },
  reports: RoomReport[],
  now: Date,
): Promise<AlertJob[]> {
  const jobs: AlertJob[] = [];
  const add = (j: AlertJob | null) => void (j && jobs.push(j));
  const rooms = await db.room.findMany({ where: { gatewayId: gw.id, orgId: gw.orgId } });
  const byId = new Map(rooms.map((r) => [r.id, r]));

  for (const report of reports) {
    const room = byId.get(report.roomId);
    if (!room) continue;
    const base = { orgId: gw.orgId, roomId: room.id, gatewayId: gw.id };
    // A staging room is for trying things out: it is watched, but never raises a problem or an alert.
    const raise: typeof openIncident = room.kind === 'staging' ? async () => null : openIncident;

    if (report.status !== 'unloaded') {
      const known = new Map(
        (await db.deviceStatus.findMany({ where: { roomId: room.id } })).map((d) => [
          d.deviceId,
          d,
        ]),
      );
      const seen = new Set<string>();
      // Watched points the gateway read this time, and the devices that are answering.
      const readSubjects = new Set<string>();
      const answering = new Set<string>();
      for (const d of report.devices) {
        seen.add(d.deviceId);
        if (d.online) answering.add(d.deviceId);
        const subject = `${room.id}:${d.deviceId}`;
        let since = now;
        const row = known.get(d.deviceId);
        // What the device says about itself. A heartbeat that leaves the firmware out (the gateway
        // has just restarted and not asked yet) keeps the last version rather than forgetting it.
        // Kept when a heartbeat leaves it out (a device that briefly answers nothing still had a
        // last known state worth showing).
        const feedbackChanged =
          !!d.feedback && JSON.stringify(d.feedback) !== JSON.stringify(row?.feedback ?? null);
        const about = {
          ...(d.driver && d.driver !== row?.driver ? { driver: d.driver } : {}),
          ...(d.firmware && d.firmware !== row?.firmware
            ? { firmware: d.firmware, firmwareSince: now }
            : {}),
          ...(feedbackChanged ? { feedback: d.feedback as Prisma.InputJsonValue } : {}),
          // Like firmware: a heartbeat that leaves details out means "unchanged", not "none".
          ...(d.details && JSON.stringify(d.details) !== JSON.stringify(row?.details ?? null)
            ? { details: d.details as Prisma.InputJsonValue }
            : {}),
        };
        if (!row) {
          await db.deviceStatus.create({
            data: {
              orgId: gw.orgId,
              roomId: room.id,
              deviceId: d.deviceId,
              name: d.name,
              online: d.online,
              since: now,
              ...about,
            },
          });
        } else {
          const patch: Record<string, unknown> = { ...about };
          if (row.online !== d.online)
            Object.assign(patch, { online: d.online, since: now, name: d.name });
          else {
            since = row.since;
            if (row.name !== d.name) patch.name = d.name;
          }
          if (Object.keys(patch).length > 0)
            await db.deviceStatus.update({ where: { id: row.id }, data: patch });
        }
        if (d.online)
          add(await resolveIncident(db, { orgId: gw.orgId, kind: 'device_offline', subject }, now));
        else if (now.getTime() - since.getTime() >= DEVICE_GRACE_MS)
          add(
            await raise(
              db,
              {
                ...base,
                kind: 'device_offline',
                subject,
                severity: 'warning',
                title: `${d.name} is offline`,
                detail: `${d.name} in ${room.name} has not answered since ${formatInZone(since, await siteTimezone(db, room.siteId))}.`,
              },
              now,
            ),
          );
        for (const w of d.watched ?? []) {
          const watchSubject = `${subject}:${w.pointId}`;
          readSubjects.add(watchSubject);
          if (w.ok)
            add(
              await resolveIncident(
                db,
                { orgId: gw.orgId, kind: 'point_alert', subject: watchSubject },
                now,
              ),
            );
          else
            add(
              await raise(
                db,
                {
                  ...base,
                  kind: 'point_alert',
                  subject: watchSubject,
                  severity: w.severity,
                  title: `${d.name}: ${w.name}`,
                  detail: `${w.message ?? `${w.name} is out of bounds`} (${d.name} in ${room.name}).`,
                },
                now,
              ),
            );
        }
      }
      // A watch that was taken off a point (or a device that was dropped) no longer holds its
      // incident open. A device that is offline is left alone: it cannot be read, not read as fine.
      const openPoints = await db.incident.findMany({
        where: { orgId: gw.orgId, roomId: room.id, kind: 'point_alert', status: 'open' },
      });
      for (const inc of openPoints) {
        const deviceId = inc.subject.split(':')[1] ?? '';
        if (readSubjects.has(inc.subject) || (seen.has(deviceId) && !answering.has(deviceId)))
          continue;
        add(
          await resolveIncident(
            db,
            { orgId: gw.orgId, kind: 'point_alert', subject: inc.subject },
            now,
          ),
        );
      }
      // A new release may have dropped devices; forget them and close anything open for them.
      for (const [deviceId, row] of known)
        if (!seen.has(deviceId)) {
          await db.deviceStatus.delete({ where: { id: row.id } });
          add(
            await resolveIncident(
              db,
              { orgId: gw.orgId, kind: 'device_offline', subject: `${room.id}:${deviceId}` },
              now,
            ),
          );
        }
    }

    if (report.status === 'fault')
      add(
        await raise(
          db,
          {
            ...base,
            kind: 'room_fault',
            subject: room.id,
            severity: 'critical',
            title: `${room.name} has a fault`,
            detail: report.error ?? null,
          },
          now,
        ),
      );
    else
      add(
        await resolveIncident(db, { orgId: gw.orgId, kind: 'room_fault', subject: room.id }, now),
      );

    if (report.error)
      add(
        await raise(
          db,
          {
            ...base,
            kind: 'deploy_failed',
            subject: room.id,
            severity: 'warning',
            title: `${room.name} could not take its new release`,
            detail: report.error,
          },
          now,
        ),
      );
    else
      add(
        await resolveIncident(
          db,
          { orgId: gw.orgId, kind: 'deploy_failed', subject: room.id },
          now,
        ),
      );
  }
  return jobs;
}

/**
 * Checks what heartbeats can't: gateways that have gone quiet, and commands nobody picked up.
 * Safe to run as often as you like.
 */
export async function sweep(db: MonitoringDb, now = new Date()): Promise<AlertJob[]> {
  const jobs: AlertJob[] = [];
  const gateways = await db.gateway.findMany({ where: { enrolledAt: { not: null } } });
  // An organisation scheduled for deletion has had its gateways let go: they are not "offline".
  const suspended = new Set(
    (await db.org.findMany({ where: { deletedAt: { gt: new Date(0) } } })).map((o) => o.id),
  );
  const monitored = new Map<string, boolean>();
  for (const gw of gateways) {
    if (suspended.has(gw.orgId)) continue;
    if (!monitored.has(gw.orgId))
      monitored.set(gw.orgId, (await getEntitlements(db, gw.orgId, now)).monitoring);
    if (!monitored.get(gw.orgId)) continue;
    const status = effectiveStatus(gw, now.getTime());
    const key = { orgId: gw.orgId, kind: 'gateway_offline' as const, subject: gw.id };
    const job =
      status === 'offline'
        ? await openIncident(
            db,
            {
              orgId: gw.orgId,
              gatewayId: gw.id,
              kind: 'gateway_offline',
              subject: gw.id,
              severity: 'critical',
              title: `Gateway ${gw.name} is offline`,
              detail: gw.lastSeenAt
                ? `Last heard from at ${formatInZone(gw.lastSeenAt, await siteTimezone(db, gw.siteId))}. Rooms keep running on site.`
                : null,
            },
            now,
          )
        : await resolveIncident(db, key, now);
    if (job) jobs.push(job);
  }
  await db.remoteCommand.updateMany({
    where: {
      status: 'pending',
      createdAt: { lt: new Date(now.getTime() - COMMAND_PENDING_EXPIRY_MS) },
    },
    data: {
      status: 'expired',
      finishedAt: now,
      error: 'The gateway did not pick this up in time.',
    },
  });
  await db.remoteCommand.updateMany({
    where: { status: 'sent', sentAt: { lt: new Date(now.getTime() - COMMAND_SENT_EXPIRY_MS) } },
    data: { status: 'expired', finishedAt: now, error: 'The gateway never reported a result.' },
  });
  // Tickets by rule, for incidents that have been open long enough. A database without the rule
  // table (older tests) has none.
  if ('ticketRule' in db) {
    try {
      await autoTicket(db as unknown as AutomationDb, now, (t, e) =>
        mirrorTicket(db as unknown as ItsmDb, { fetch: pinnedFetch, resolve: resolveAll }, t, e),
      );
    } catch {
      // Raising tickets must never stop monitoring.
    }
  }
  return jobs;
}

let lastSweep = 0;
/** Sweeps at most once per interval per server instance. */
export async function maybeSweep(
  db: MonitoringDb,
  now = new Date(),
  everyMs = 30_000,
): Promise<AlertJob[]> {
  if (now.getTime() - lastSweep < everyMs) return [];
  lastSweep = now.getTime();
  return sweep(db, now);
}

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export type HealthLevel = 'healthy' | 'degraded' | 'down' | 'unknown';
export interface Health {
  level: HealthLevel;
  /** 0-100, or null when the room's state can't be known. */
  score: number | null;
  reasons: string[];
}

export function roomHealth(input: {
  gatewayStatus: 'pending' | 'online' | 'offline' | null;
  deployed: boolean;
  status: string | null;
  devices: { online: boolean }[];
  openIncidents: { severity: string }[];
}): Health {
  if (!input.gatewayStatus)
    return { level: 'unknown', score: null, reasons: ['Not assigned to a gateway'] };
  if (input.gatewayStatus !== 'online')
    return {
      level: 'unknown',
      score: null,
      reasons: [
        input.gatewayStatus === 'offline'
          ? 'Gateway offline, so the room’s state is unknown'
          : 'Gateway has not connected yet',
      ],
    };
  if (!input.deployed) return { level: 'unknown', score: null, reasons: ['Nothing deployed yet'] };

  const reasons: string[] = [];
  let score = 100;
  const fault = input.status === 'fault';
  if (fault) {
    score -= 40;
    reasons.push('The room reports a fault');
  }
  const offline = input.devices.filter((d) => !d.online).length;
  if (offline > 0) {
    score -= 20 + Math.round((60 * offline) / input.devices.length);
    reasons.push(`${offline} of ${input.devices.length} devices offline`);
  }
  for (const i of input.openIncidents)
    score -= i.severity === 'critical' ? 20 : i.severity === 'warning' ? 10 : 0;
  score = Math.max(0, Math.min(100, score));
  const level: HealthLevel = fault || score < 50 ? 'down' : score < 90 ? 'degraded' : 'healthy';
  if (reasons.length === 0 && input.openIncidents.length > 0)
    reasons.push(`${input.openIncidents.length} open incident(s)`);
  return { level, score, reasons };
}
