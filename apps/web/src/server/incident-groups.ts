import type { PrismaClient } from '@kestrel/db';
import type { AlertJob } from './monitoring';
import { meetingPressure } from './room-schedule';

// Devices on one network that go silent together are one problem, not several. Three or more
// device_offline incidents on the same gateway and the same /24 subnet become one "group" incident
// (kind group_outage); the devices' own incidents stay, pointing at it through `parentId`. Alerts and
// tickets go to the group only, so a switch that takes ten devices down is one page, not ten.
//
// This is deliberately plain: no guessing from names or models, and no topology yet. Devices with
// no IPv4 address are never grouped. A group can be undone by resolving the devices (it resolves
// itself when the last one is back) and is never created from a single device.
export type GroupDb = Pick<PrismaClient, 'incident' | 'device'> &
  Partial<Pick<PrismaClient, 'roomSchedule'>>;

/** Devices needed in one subnet before they are grouped. */
export const GROUP_MIN = 3;
/** The devices must have gone quiet within this long of each other for a new group to form. */
export const GROUP_WINDOW_MS = 10 * 60_000;
const NAMES_LISTED = 8;

/** The /24 an IPv4 address is in ("10.1.2.0/24"), or null when it is not a plain IPv4 address. */
export function subnetOf(ip: string | null | undefined): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec((ip ?? '').trim());
  if (!m || m.slice(1).some((o) => Number(o) > 255)) return null;
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}.0/24`;
}

const deviceIdOf = (subject: string) => (subject.startsWith('device:') ? subject.slice(7) : null);
const groupSubject = (gatewayId: string, subnet: string) => `group:${gatewayId}:${subnet}`;

type Row = NonNullable<Awaited<ReturnType<GroupDb['incident']['findFirst']>>>;

/**
 * Takes the alert jobs one heartbeat produced and groups what belongs together: a new or growing
 * group replaces its devices' "opened" alerts with one for the group, and a group's last device
 * coming back resolves the group. Anything it cannot group passes through untouched. Grouping is
 * only ever extra, so any failure here leaves the alerts exactly as they were.
 */
export async function groupOutages(
  db: GroupDb,
  gw: { id: string; orgId: string },
  jobs: AlertJob[],
  now: Date,
): Promise<AlertJob[]> {
  try {
    return await group(db, gw, jobs, now);
  } catch (e) {
    console.error('[incident-groups] could not group outages', e);
    return jobs;
  }
}

async function group(
  db: GroupDb,
  gw: { id: string; orgId: string },
  jobs: AlertJob[],
  now: Date,
): Promise<AlertJob[]> {
  const orgId = gw.orgId;
  const dropped = new Set<AlertJob>();
  const added: AlertJob[] = [];
  const touched = new Set<string>();

  // The jobs that concern a device incident, with the incident each is about.
  const ids = [...new Set(jobs.map((j) => j.incidentId))];
  const rows = ids.length ? await db.incident.findMany({ where: { orgId, id: { in: ids } } }) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  // A device that comes back no longer needs its own "resolved": the group says so, once.
  for (const job of jobs) {
    const inc = byId.get(job.incidentId);
    if (job.event === 'resolved' && inc?.kind === 'device_offline' && inc.parentId) {
      dropped.add(job);
      touched.add(inc.parentId);
    }
  }

  // Every open device outage on this gateway, and the groups they sit in.
  const open = await db.incident.findMany({
    where: { orgId, kind: 'device_offline', status: 'open', gatewayId: gw.id },
  });
  const parentIds = [...new Set(open.map((o) => o.parentId).filter((x): x is string => !!x))];
  const parents = parentIds.length
    ? await db.incident.findMany({ where: { orgId, id: { in: parentIds } } })
    : [];
  const parentOf = new Map(parents.map((p) => [p.id, p]));
  // A device that dropped out again after its group resolved starts over, ungrouped.
  for (const o of open) {
    if (o.parentId && parentOf.get(o.parentId)?.status !== 'open') {
      await db.incident.update({ where: { id: o.id }, data: { parentId: null } });
      o.parentId = null;
    }
  }

  const newlyOpened = new Set(
    jobs
      .filter((j) => j.event === 'opened' && byId.get(j.incidentId)?.kind === 'device_offline')
      .map((j) => j.incidentId),
  );
  const loose = open.filter((o) => !o.parentId);
  if (loose.length) {
    const deviceIds = loose.map((o) => deviceIdOf(o.subject)).filter((x): x is string => !!x);
    const devices = deviceIds.length
      ? await db.device.findMany({ where: { orgId, id: { in: deviceIds } } })
      : [];
    const subnetOfDevice = new Map(devices.map((d) => [d.id, subnetOf(d.ip)]));
    const nameOfDevice = new Map(devices.map((d) => [d.id, d.name]));
    const bySubnet = new Map<string, Row[]>();
    for (const o of loose) {
      const subnet = subnetOfDevice.get(deviceIdOf(o.subject) ?? '');
      if (subnet) bySubnet.set(subnet, [...(bySubnet.get(subnet) ?? []), o]);
    }

    for (const [subnet, members] of bySubnet) {
      const subject = groupSubject(gw.id, subnet);
      const existing = await db.incident.findFirst({
        where: { orgId, kind: 'group_outage', subject, status: 'open' },
      });
      let parent: Row | null = existing;
      let joining = members;
      if (!parent) {
        // A new group needs enough devices that went quiet together, and something new to say.
        joining = members.filter((m) => now.getTime() - m.openedAt.getTime() <= GROUP_WINDOW_MS);
        if (joining.length < GROUP_MIN || !joining.some((m) => newlyOpened.has(m.id))) continue;
        const rooms = [
          ...new Set(joining.flatMap((m) => [...(m.roomId ? [m.roomId] : []), ...m.roomIds])),
        ];
        let meetings = 0;
        try {
          meetings = await meetingPressure(db, orgId, rooms, now);
        } catch (e) {
          console.error('[incident-groups] could not check meetings', e);
        }
        parent = await db.incident.create({
          data: {
            orgId,
            // Rooms are counted through their devices' own incidents; the group belongs to the gateway.
            roomId: null,
            gatewayId: gw.id,
            kind: 'group_outage',
            subject,
            severity: 'critical',
            status: 'open',
            title: `${joining.length} devices on ${subnet} stopped answering together`,
            detail: describe(joining, nameOfDevice),
            openedAt: now,
            lastSeenAt: now,
            occurrences: 1,
            alerted: true,
            meetingsAffected: meetings,
          },
        });
        added.push({ incidentId: parent.id, event: 'opened' });
      }
      for (const m of joining) {
        await db.incident.update({ where: { id: m.id }, data: { parentId: parent.id } });
        m.parentId = parent.id;
        // Its own "opened" alert is replaced by the group's.
        for (const j of jobs) if (j.incidentId === m.id && j.event === 'opened') dropped.add(j);
      }
      touched.add(parent.id);
    }
  }

  // Keep each touched group true: resolved when none of its devices is still out, and otherwise
  // its count and device list are brought up to date.
  for (const parentId of touched) {
    const parent = await db.incident.findFirst({ where: { id: parentId, orgId } });
    if (!parent || parent.status !== 'open') continue;
    const children = await db.incident.findMany({ where: { orgId, parentId } });
    const stillOut = children.filter((c) => c.status === 'open');
    if (stillOut.length === 0) {
      await db.incident.update({
        where: { id: parentId },
        data: { status: 'resolved', resolvedAt: now },
      });
      if (!added.some((a) => a.incidentId === parentId))
        added.push({ incidentId: parentId, event: 'resolved' });
      continue;
    }
    const deviceIds = stillOut.map((c) => deviceIdOf(c.subject)).filter((x): x is string => !!x);
    const names = deviceIds.length
      ? new Map(
          (await db.device.findMany({ where: { orgId, id: { in: deviceIds } } })).map((d) => [
            d.id,
            d.name,
          ]),
        )
      : new Map<string, string>();
    await db.incident.update({
      where: { id: parentId },
      data: {
        lastSeenAt: now,
        title: parent.title.replace(
          /^\d+ devices?/,
          `${stillOut.length} device${stillOut.length === 1 ? '' : 's'}`,
        ),
        detail: describe(stillOut, names),
      },
    });
  }

  return [...jobs.filter((j) => !dropped.has(j)), ...added];
}

function describe(members: Row[], names: Map<string, string>): string {
  const list = members
    .map((m) => names.get(deviceIdOf(m.subject) ?? '') ?? m.title)
    .sort((a, b) => a.localeCompare(b));
  const shown = list.slice(0, NAMES_LISTED).join(', ');
  const more = list.length > NAMES_LISTED ? ` and ${list.length - NAMES_LISTED} more` : '';
  return `${shown}${more}. They went quiet together, so the cause is probably shared: check the network switch, power or the link to the gateway first.`;
}
