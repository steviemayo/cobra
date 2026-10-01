import { signDocument } from '@kestrel/crypto';
import type { Prisma, PrismaClient } from '@kestrel/db';
import {
  PM_AUTO_LABEL,
  PmItems,
  PmResult,
  STARTER_PM_TEMPLATES,
  addDays,
  checkPmItems,
  countFailed,
  dueState,
  nextDueAfter,
  toDay,
  unanswered,
  type DueState,
  type PmAutoSource,
  type PmItem,
} from '@kestrel/model';
import { openIncident, resolveIncident, type AlertJob, type MonitoringDb } from './monitoring';
import { PM_REPORT_PURPOSE } from './register-issues';
import type { SigningKey } from './signing';

// Preventative maintenance (docs/pivot-monitoring.md): checklists, schedules per room or device,
// runs with the items monitoring can answer filled in, and a signed-off record that is never edited.
// Functions take the database as a parameter so they can be tested without one.
export type PmDb = Pick<
  PrismaClient,
  | 'pmTemplate'
  | 'pmSchedule'
  | 'pmRun'
  | 'room'
  | 'device'
  | 'incident'
  | 'ticket'
  | 'org'
  | 'registerIssue'
  | 'deviceEvent'
>;

type Result<T = { id: string }> = { ok: true; value: T } | { ok: false; message: string };
const bad = (message: string): { ok: false; message: string } => ({ ok: false, message });
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const parseItems = (v: unknown): PmItem[] => {
  const r = PmItems.safeParse(v);
  return r.success ? r.data : [];
};

// ---- Templates -----------------------------------------------------------------------------------

export async function createTemplate(
  db: PmDb,
  input: {
    orgId: string;
    name: string;
    appliesTo: 'room' | 'device';
    category?: string | null;
    items: unknown;
    userId: string | null;
  },
): Promise<Result> {
  const items = PmItems.safeParse(input.items);
  if (!items.success) return bad('That checklist is not valid');
  const problem = checkPmItems(items.data);
  if (problem) return bad(problem);
  if (await db.pmTemplate.findFirst({ where: { orgId: input.orgId, name: input.name } }))
    return bad('There is already a checklist with that name');
  const row = await db.pmTemplate.create({
    data: {
      orgId: input.orgId,
      name: input.name,
      appliesTo: input.appliesTo,
      category: input.category ?? null,
      items: items.data as unknown as Prisma.InputJsonValue,
      version: 1,
      createdBy: input.userId,
    },
  });
  return { ok: true, value: { id: row.id } };
}

export async function updateTemplate(
  db: PmDb,
  input: {
    orgId: string;
    templateId: string;
    name?: string;
    category?: string | null;
    items?: unknown;
  },
): Promise<Result> {
  const row = await db.pmTemplate.findFirst({
    where: { id: input.templateId, orgId: input.orgId },
  });
  if (!row) return bad('No such checklist');
  const data: Record<string, unknown> = {};
  if (input.name !== undefined && input.name !== row.name) {
    if (await db.pmTemplate.findFirst({ where: { orgId: input.orgId, name: input.name } }))
      return bad('There is already a checklist with that name');
    data.name = input.name;
  }
  if (input.category !== undefined) data.category = input.category;
  if (input.items !== undefined) {
    const items = PmItems.safeParse(input.items);
    if (!items.success) return bad('That checklist is not valid');
    const problem = checkPmItems(items.data);
    if (problem) return bad(problem);
    if (JSON.stringify(items.data) !== JSON.stringify(row.items)) {
      data.items = items.data as unknown as Prisma.InputJsonValue;
      // Runs already signed keep the version they used.
      data.version = row.version + 1;
    }
  }
  if (Object.keys(data).length) await db.pmTemplate.update({ where: { id: row.id }, data });
  return { ok: true, value: { id: row.id } };
}

export async function deleteTemplate(db: PmDb, orgId: string, templateId: string): Promise<Result> {
  const row = await db.pmTemplate.findFirst({ where: { id: templateId, orgId } });
  if (!row) return bad('No such checklist');
  if (await db.pmSchedule.findFirst({ where: { templateId, orgId } }))
    return bad('A schedule uses this checklist. Remove the schedule first.');
  await db.pmTemplate.delete({ where: { id: templateId } });
  return { ok: true, value: { id: templateId } };
}

/** Adds Kestrel's starter checklists that the organisation does not already have. */
export async function addStarterTemplates(
  db: PmDb,
  orgId: string,
  userId: string | null,
): Promise<number> {
  let n = 0;
  for (const t of STARTER_PM_TEMPLATES) {
    const r = await createTemplate(db, {
      orgId,
      name: t.name,
      appliesTo: t.appliesTo,
      category: t.category ?? null,
      items: t.items,
      userId,
    });
    if (r.ok) n++;
  }
  return n;
}

// ---- Schedules -----------------------------------------------------------------------------------

export async function createSchedule(
  db: PmDb,
  input: {
    orgId: string;
    templateId: string;
    roomId?: string | null;
    deviceId?: string | null;
    intervalDays: number;
    firstDueOn: Date;
    leadDays?: number;
    assigneeUserId?: string | null;
    assigneeMspOrgId?: string | null;
    userId: string | null;
  },
): Promise<Result> {
  const template = await db.pmTemplate.findFirst({
    where: { id: input.templateId, orgId: input.orgId },
  });
  if (!template) return bad('No such checklist');
  if (!Number.isInteger(input.intervalDays) || input.intervalDays < 1 || input.intervalDays > 1095)
    return bad('Choose an interval between 1 day and 3 years');
  if (template.appliesTo === 'room') {
    if (!input.roomId) return bad('This checklist is for a room');
    if (!(await db.room.findFirst({ where: { id: input.roomId, orgId: input.orgId } })))
      return bad('No such room');
  } else {
    if (!input.deviceId) return bad('This checklist is for a device');
    const d = await db.device.findFirst({ where: { id: input.deviceId, orgId: input.orgId } });
    if (!d) return bad('No such device');
    if (template.category && d.category !== template.category)
      return bad('This checklist is for a different kind of device');
  }
  const row = await db.pmSchedule.create({
    data: {
      orgId: input.orgId,
      templateId: template.id,
      roomId: template.appliesTo === 'room' ? input.roomId! : null,
      deviceId: template.appliesTo === 'device' ? input.deviceId! : null,
      intervalDays: input.intervalDays,
      nextDueOn: toDay(input.firstDueOn),
      leadDays: input.leadDays ?? 7,
      assigneeUserId: input.assigneeUserId ?? null,
      assigneeMspOrgId: input.assigneeMspOrgId ?? null,
      enabled: true,
      createdBy: input.userId,
    },
  });
  return { ok: true, value: { id: row.id } };
}

export async function deleteSchedule(db: PmDb, orgId: string, scheduleId: string): Promise<Result> {
  const row = await db.pmSchedule.findFirst({ where: { id: scheduleId, orgId } });
  if (!row) return bad('No such schedule');
  await resolveIncident(
    db as unknown as MonitoringDb,
    { orgId, kind: 'pm_overdue', subject: `pm:${scheduleId}` },
    new Date(),
  );
  await db.pmSchedule.delete({ where: { id: scheduleId } });
  return { ok: true, value: { id: scheduleId } };
}

export interface ScheduleView {
  id: string;
  templateId: string;
  templateName: string;
  roomId: string | null;
  deviceId: string | null;
  intervalDays: number;
  nextDueOn: Date;
  leadDays: number;
  assigneeUserId: string | null;
  assigneeMspOrgId: string | null;
  enabled: boolean;
  lastRunOn: Date | null;
  state: DueState;
}

export async function listSchedules(
  db: PmDb,
  orgId: string,
  now = new Date(),
  filter: { roomId?: string; deviceId?: string } = {},
): Promise<ScheduleView[]> {
  const [rows, templates] = await Promise.all([
    db.pmSchedule.findMany({
      where: {
        orgId,
        ...(filter.roomId ? { roomId: filter.roomId } : {}),
        ...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
      },
      orderBy: { nextDueOn: 'asc' },
    }),
    db.pmTemplate.findMany({ where: { orgId } }),
  ]);
  return rows.map((s) => ({
    id: s.id,
    templateId: s.templateId,
    templateName: templates.find((t) => t.id === s.templateId)?.name ?? 'Removed checklist',
    roomId: s.roomId,
    deviceId: s.deviceId,
    intervalDays: s.intervalDays,
    nextDueOn: s.nextDueOn,
    leadDays: s.leadDays,
    assigneeUserId: s.assigneeUserId,
    assigneeMspOrgId: s.assigneeMspOrgId,
    enabled: s.enabled,
    lastRunOn: s.lastRunOn,
    state: s.enabled ? dueState(s.nextDueOn, s.leadDays, now) : 'ok',
  }));
}

// ---- Runs ----------------------------------------------------------------------------------------

/** What monitoring says about an auto item for this room or device, as a result and the words behind it. */
export async function autoAnswer(
  db: PmDb,
  orgId: string,
  source: PmAutoSource,
  target: { roomId: string | null; deviceId: string | null },
): Promise<{ result: 'pass' | 'fail'; value: string } | null> {
  const devices = target.deviceId
    ? await db.device.findMany({ where: { orgId, id: target.deviceId } })
    : target.roomId
      ? await db.device.findMany({ where: { orgId, roomId: target.roomId } })
      : [];
  const active = devices.filter((d) => d.kind === 'active');
  const drifted = (d: (typeof devices)[number]) =>
    Object.entries(isObject(d.configState) ? d.configState : {}).some(
      ([f, s]) => f !== '__push' && isObject(s) && s.drifted === true,
    );
  switch (source) {
    case 'devices_online': {
      if (active.length === 0) return null;
      const off = active.filter((d) => d.online !== true);
      return {
        result: off.length ? 'fail' : 'pass',
        value: off.length
          ? `${off.length} of ${active.length} not answering`
          : `All ${active.length} answering`,
      };
    }
    case 'device_online': {
      const d = active[0];
      if (!d) return null;
      return {
        result: d.online === true ? 'pass' : 'fail',
        value: d.online === true ? 'Answering' : 'Not answering',
      };
    }
    case 'firmware_known': {
      const d = devices[0];
      if (!d) return null;
      return {
        result: d.firmware ? 'pass' : 'fail',
        value: d.firmware ? `Firmware ${d.firmware}` : 'Firmware not reported',
      };
    }
    case 'no_config_drift': {
      if (active.length === 0) return null;
      const n = active.filter(drifted).length;
      return {
        result: n ? 'fail' : 'pass',
        value: n ? `${n} device${n === 1 ? '' : 's'} drifted` : 'Nothing drifted',
      };
    }
    case 'no_open_incidents': {
      const where = target.deviceId
        ? { orgId, status: 'open', subject: { startsWith: `device:${target.deviceId}` } }
        : target.roomId
          ? { orgId, status: 'open', roomId: target.roomId }
          : null;
      if (!where) return null;
      const n = (await db.incident.findMany({ where })).length;
      return { result: n ? 'fail' : 'pass', value: n ? `${n} open` : 'None open' };
    }
  }
}

/** Starts a visit: a draft run with everything monitoring can answer already filled in. */
export async function startRun(
  db: PmDb,
  input: {
    orgId: string;
    templateId: string;
    scheduleId?: string | null;
    roomId?: string | null;
    deviceId?: string | null;
    userId: string | null;
  },
  now = new Date(),
): Promise<Result> {
  const template = await db.pmTemplate.findFirst({
    where: { id: input.templateId, orgId: input.orgId },
  });
  if (!template) return bad('No such checklist');
  const schedule = input.scheduleId
    ? await db.pmSchedule.findFirst({ where: { id: input.scheduleId, orgId: input.orgId } })
    : null;
  if (input.scheduleId && !schedule) return bad('No such schedule');
  let roomId = schedule?.roomId ?? input.roomId ?? null;
  const deviceId = schedule?.deviceId ?? input.deviceId ?? null;
  if (template.appliesTo === 'room' && !roomId) return bad('This checklist is for a room');
  if (template.appliesTo === 'device' && !deviceId) return bad('This checklist is for a device');
  if (roomId && !(await db.room.findFirst({ where: { id: roomId, orgId: input.orgId } })))
    return bad('No such room');
  const target = deviceId
    ? await db.device.findFirst({ where: { id: deviceId, orgId: input.orgId } })
    : null;
  if (deviceId && !target) return bad('No such device');
  // A visit to a device is also a visit to the room it is in, so the room's record shows it.
  if (target && !roomId) roomId = target.roomId;
  const items = parseItems(template.items);
  const results: PmResult[] = [];
  for (const i of items) {
    const answer = i.auto ? await autoAnswer(db, input.orgId, i.auto, { roomId, deviceId }) : null;
    results.push({
      itemId: i.id,
      label: i.label,
      type: i.type,
      result: answer ? answer.result : null,
      ...(answer ? { auto: { value: answer.value, at: now.toISOString() } } : {}),
    });
  }
  const run = await db.pmRun.create({
    data: {
      orgId: input.orgId,
      scheduleId: schedule?.id ?? null,
      templateId: template.id,
      templateName: template.name,
      templateVersion: template.version,
      roomId,
      deviceId,
      status: 'draft',
      results: results as unknown as Prisma.InputJsonValue,
      failedCount: 0,
      dueOn: schedule?.nextDueOn ?? null,
      startedBy: input.userId,
      createdAt: now,
    },
  });
  return { ok: true, value: { id: run.id } };
}

/** Saves answers to a draft. A signed run is never edited. */
export async function saveRun(
  db: PmDb,
  input: { orgId: string; runId: string; results: unknown; notes?: string | null },
): Promise<Result> {
  const run = await db.pmRun.findFirst({ where: { id: input.runId, orgId: input.orgId } });
  if (!run) return bad('No such visit');
  if (run.status === 'signed')
    return bad('A signed visit cannot be changed. Start a new one to correct it.');
  const parsed = PmResult.array().safeParse(input.results);
  if (!parsed.success) return bad('Those answers are not valid');
  const template = await db.pmTemplate.findFirst({
    where: { id: run.templateId, orgId: input.orgId },
  });
  const items = parseItems(template?.items);
  const known = new Set(items.map((i) => i.id));
  if (parsed.data.some((r) => !known.has(r.itemId)))
    return bad('An answer is for an item that is not on the checklist');
  await db.pmRun.update({
    where: { id: run.id },
    data: {
      results: parsed.data as unknown as Prisma.InputJsonValue,
      notes: input.notes ?? run.notes,
      failedCount: countFailed(items, parsed.data),
    },
  });
  return { ok: true, value: { id: run.id } };
}

/**
 * Signs a visit off: it can no longer change. Failed items can raise one ticket for the room or
 * device and put a failed device's asset record in repair, and the schedule moves on.
 */
export async function signRun(
  db: PmDb,
  input: {
    orgId: string;
    runId: string;
    userId: string | null;
    name: string;
    raiseTicket: boolean;
    markInRepair: boolean;
  },
  now = new Date(),
): Promise<Result<{ id: string; failed: number; ticketId: string | null }>> {
  const run = await db.pmRun.findFirst({ where: { id: input.runId, orgId: input.orgId } });
  if (!run) return bad('No such visit');
  if (run.status === 'signed') return bad('This visit is already signed off');
  if (!input.name.trim()) return bad('Type your name to sign it off');
  const template = await db.pmTemplate.findFirst({
    where: { id: run.templateId, orgId: input.orgId },
  });
  const items = parseItems(template?.items);
  const results = PmResult.array().catch([]).parse(run.results);
  const missing = unanswered(items, results);
  if (missing.length)
    return bad(
      `Still to answer: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}`,
    );
  const failed = countFailed(items, results);
  let ticketId: string | null = null;
  if (failed > 0 && input.raiseTicket) {
    const failedItems = results.filter(
      (r) => items.find((i) => i.id === r.itemId) && countFailed(items, [r]) > 0,
    );
    const ticket = await db.ticket.create({
      data: {
        orgId: input.orgId,
        roomId: run.roomId,
        deviceId: run.deviceId,
        title: `${run.templateName}: ${failed} item${failed === 1 ? '' : 's'} failed`,
        body: `Found during a maintenance visit on ${now.toISOString().slice(0, 10)}.\n${failedItems.map((r) => `- ${r.label}${r.note ? ` (${r.note})` : ''}`).join('\n')}`,
        status: 'open',
        priority: 'normal',
        routedTo: 'org',
        ruleEscalated: false,
        createdBy: input.userId,
        createdAt: now,
      },
    });
    ticketId = ticket.id;
  }
  if (failed > 0 && input.markInRepair && run.deviceId) {
    const d = await db.device.findFirst({ where: { id: run.deviceId, orgId: input.orgId } });
    if (d && d.status !== 'in_repair') {
      await db.device.update({ where: { id: d.id }, data: { status: 'in_repair' } });
      await db.deviceEvent.create({
        data: {
          orgId: input.orgId,
          deviceId: d.id,
          type: 'status_changed',
          field: 'status',
          oldValue: d.status,
          newValue: 'in_repair',
          source: 'system',
          actorId: input.userId,
          at: now,
        },
      });
    }
  }
  if (run.deviceId)
    await db.deviceEvent.create({
      data: {
        orgId: input.orgId,
        deviceId: run.deviceId,
        type: failed ? 'pm_failed' : 'pm_passed',
        source: 'manual',
        actorId: input.userId,
        data: { runId: run.id, template: run.templateName, failed } as Prisma.InputJsonValue,
        at: now,
      },
    });
  await db.pmRun.update({
    where: { id: run.id },
    data: {
      status: 'signed',
      signedBy: input.userId,
      signedByName: input.name.trim(),
      signedAt: now,
      failedCount: failed,
    },
  });
  if (run.scheduleId) {
    const s = await db.pmSchedule.findFirst({ where: { id: run.scheduleId, orgId: input.orgId } });
    if (s) {
      await db.pmSchedule.update({
        where: { id: s.id },
        data: {
          nextDueOn: nextDueAfter(run.dueOn ?? s.nextDueOn, toDay(now), s.intervalDays),
          lastRunOn: toDay(now),
        },
      });
      await resolveIncident(
        db as unknown as MonitoringDb,
        { orgId: input.orgId, kind: 'pm_overdue', subject: `pm:${s.id}` },
        now,
      );
    }
  }
  return { ok: true, value: { id: run.id, failed, ticketId } };
}

/** Removes a draft that was started by mistake. A signed visit is never removed. */
export async function discardRun(db: PmDb, orgId: string, runId: string): Promise<Result> {
  const run = await db.pmRun.findFirst({ where: { id: runId, orgId } });
  if (!run) return bad('No such visit');
  if (run.status === 'signed') return bad('A signed visit cannot be removed');
  await db.pmRun.delete({ where: { id: runId } });
  return { ok: true, value: { id: runId } };
}

// ---- Overview, overdue and reports ---------------------------------------------------------------

export interface PmStatus {
  overdue: number;
  dueSoon: number;
  schedules: number;
  /** Of visits signed in the last 12 months that had a due date, the share signed on or before it. Null with none. */
  onTimePct: number | null;
}

export async function pmStatus(
  db: PmDb,
  orgId: string,
  now = new Date(),
  roomIds: Set<string> | null = null,
): Promise<PmStatus> {
  const [schedules, runs] = await Promise.all([
    db.pmSchedule.findMany({ where: { orgId, enabled: true } }),
    db.pmRun.findMany({ where: { orgId, status: 'signed' } }),
  ]);
  const inScope = (s: { roomId: string | null }) =>
    roomIds === null || (s.roomId !== null && roomIds.has(s.roomId));
  const mine = schedules.filter(inScope);
  const states = mine.map((s) => dueState(s.nextDueOn, s.leadDays, now));
  const yearAgo = now.getTime() - 365 * 86_400_000;
  const recent = runs.filter(
    (r) =>
      r.dueOn &&
      r.signedAt &&
      r.signedAt.getTime() >= yearAgo &&
      (roomIds === null || (r.roomId !== null && roomIds.has(r.roomId))),
  );
  const onTime = recent.filter(
    (r) => toDay(r.signedAt!).getTime() <= toDay(r.dueOn!).getTime(),
  ).length;
  return {
    overdue: states.filter((s) => s === 'overdue').length,
    dueSoon: states.filter((s) => s === 'due_soon').length,
    schedules: mine.length,
    onTimePct: recent.length ? Math.round((onTime / recent.length) * 100) : null,
  };
}

/** Daily: an info-level incident for each overdue schedule, closed when the visit is signed off. */
export async function pmSweep(db: PmDb, now = new Date()): Promise<AlertJob[]> {
  const jobs: AlertJob[] = [];
  const schedules = await db.pmSchedule.findMany({ where: { enabled: true } });
  const templates = await db.pmTemplate.findMany({});
  for (const s of schedules) {
    const state = dueState(s.nextDueOn, s.leadDays, now);
    const subject = `pm:${s.id}`;
    if (state === 'overdue') {
      const name = templates.find((t) => t.id === s.templateId)?.name ?? 'Maintenance check';
      const job = await openIncident(
        db as unknown as MonitoringDb,
        {
          orgId: s.orgId,
          roomId: s.roomId,
          kind: 'pm_overdue',
          subject,
          severity: 'info',
          title: `${name} is overdue`,
          detail: `It was due on ${s.nextDueOn.toISOString().slice(0, 10)}.`,
        },
        now,
      );
      if (job) jobs.push(job);
    } else {
      const job = await resolveIncident(
        db as unknown as MonitoringDb,
        { orgId: s.orgId, kind: 'pm_overdue', subject },
        now,
      );
      if (job) jobs.push(job);
    }
  }
  return jobs;
}

export interface PmReportRun {
  id: string;
  template: string;
  room: string | null;
  device: string | null;
  signedAt: string;
  signedBy: string | null;
  failed: number;
  onTime: boolean | null;
  results: { label: string; result: string | number | null; note?: string }[];
}

/** Signs a report of every visit signed off between two dates, for keeping. */
export async function issuePmReport(
  db: PmDb,
  input: { orgId: string; from: Date; to: Date; userId: string | null },
  signing: SigningKey,
  now = new Date(),
): Promise<Result<{ id: string; number: number }>> {
  const org = await db.org.findFirst({ where: { id: input.orgId } });
  if (!org) return bad('No such organisation');
  if (input.to.getTime() < input.from.getTime()) return bad('The end date is before the start');
  const [runs, rooms, devices, last] = await Promise.all([
    db.pmRun.findMany({
      where: { orgId: input.orgId, status: 'signed' },
      orderBy: { signedAt: 'asc' },
    }),
    db.room.findMany({ where: { orgId: input.orgId } }),
    db.device.findMany({ where: { orgId: input.orgId } }),
    db.registerIssue.findMany({
      where: { orgId: input.orgId, kind: 'pm_report' },
      orderBy: { number: 'desc' },
    }),
  ]);
  const inRange = runs.filter(
    (r) =>
      r.signedAt &&
      r.signedAt.getTime() >= input.from.getTime() &&
      r.signedAt.getTime() <= input.to.getTime() + 86_399_999,
  );
  const rows: PmReportRun[] = inRange.map((r) => ({
    id: r.id,
    template: r.templateName,
    room: rooms.find((x) => x.id === r.roomId)?.name ?? null,
    device: devices.find((x) => x.id === r.deviceId)?.name ?? null,
    signedAt: r.signedAt!.toISOString(),
    signedBy: r.signedByName,
    failed: r.failedCount,
    onTime: r.dueOn ? toDay(r.signedAt!).getTime() <= toDay(r.dueOn).getTime() : null,
    results: (PmResult.array().catch([]).parse(r.results) ?? []).map((x) => ({
      label: x.label,
      result: x.result,
      ...(x.note ? { note: x.note } : {}),
    })),
  }));
  const number = (last[0]?.number ?? 0) + 1;
  const withDue = rows.filter((r) => r.onTime !== null);
  const payload = {
    orgId: input.orgId,
    orgName: org.name,
    kind: 'pm_report' as const,
    number,
    title: `Maintenance report M${number}: ${input.from.toISOString().slice(0, 10)} to ${input.to.toISOString().slice(0, 10)}`,
    takenAt: now.toISOString(),
    from: input.from.toISOString().slice(0, 10),
    to: input.to.toISOString().slice(0, 10),
    summary: {
      visits: rows.length,
      withFailures: rows.filter((r) => r.failed > 0).length,
      itemsFailed: rows.reduce((n, r) => n + r.failed, 0),
      onTimePct: withDue.length
        ? Math.round((withDue.filter((r) => r.onTime).length / withDue.length) * 100)
        : null,
    },
    runs: rows,
  };
  const doc = signDocument(PM_REPORT_PURPOSE, payload, signing);
  const row = await db.registerIssue.create({
    data: {
      orgId: input.orgId,
      kind: 'pm_report',
      number,
      scope: 'org',
      scopeId: null,
      title: payload.title,
      payload: doc as unknown as Prisma.InputJsonValue,
      hash: doc.hash,
      signature: doc.signature,
      keyId: doc.keyId,
      takenBy: input.userId,
      takenAt: now,
    },
  });
  return { ok: true, value: { id: row.id, number } };
}

export { PM_AUTO_LABEL, addDays };
