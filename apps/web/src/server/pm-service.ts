import { createHash } from 'node:crypto';
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
  | 'pmPhoto'
  | 'room'
  | 'area'
  | 'site'
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

// ---- Photos --------------------------------------------------------------------------------------

/** The browser shrinks a photo before sending it; these are the limits the server holds it to. */
export const PM_PHOTO_MAX_BYTES = 1_500_000;
export const PM_PHOTO_MAX_PER_ITEM = 4;
export const PM_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Whether the bytes really are the image type they claim, by their first bytes. */
export function looksLikeImage(mime: string, b: Uint8Array): boolean {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (mime === 'image/jpeg') return at(0, 0xff, 0xd8, 0xff);
  if (mime === 'image/png') return at(0, 0x89, 0x50, 0x4e, 0x47);
  if (mime === 'image/webp') return at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50);
  return false;
}

export interface PmPhotoView {
  id: string;
  itemId: string;
  mime: string;
  size: number;
  sha256: string;
  createdAt: Date;
}

/** Adds a photo to a photo item of a draft visit. A signed visit never gains one. */
export async function addPhoto(
  db: PmDb,
  input: {
    orgId: string;
    runId: string;
    itemId: string;
    mime: string;
    /** The image, base64 encoded. */
    data: string;
    userId: string | null;
  },
  now = new Date(),
): Promise<Result> {
  const run = await db.pmRun.findFirst({ where: { id: input.runId, orgId: input.orgId } });
  if (!run) return bad('No such visit');
  if (run.status === 'signed') return bad('A signed visit cannot take more photos.');
  const template = await db.pmTemplate.findFirst({
    where: { id: run.templateId, orgId: input.orgId },
  });
  const item = parseItems(template?.items).find((i) => i.id === input.itemId);
  if (!item || item.type !== 'photo') return bad('That item does not take photos.');
  if (!(PM_PHOTO_TYPES as readonly string[]).includes(input.mime))
    return bad('Photos must be JPEG, PNG or WebP.');
  const bytes = Buffer.from(input.data, 'base64');
  if (!bytes.length) return bad('That photo is empty.');
  if (bytes.length > PM_PHOTO_MAX_BYTES)
    return bad(
      `That photo is too large (the limit is ${Math.round(PM_PHOTO_MAX_BYTES / 1e6)} MB).`,
    );
  if (!looksLikeImage(input.mime, bytes)) return bad('That file is not a valid image.');
  const have = await db.pmPhoto.count({ where: { runId: run.id, itemId: input.itemId } });
  if (have >= PM_PHOTO_MAX_PER_ITEM)
    return bad(`An item takes up to ${PM_PHOTO_MAX_PER_ITEM} photos.`);
  const row = await db.pmPhoto.create({
    data: {
      orgId: input.orgId,
      runId: run.id,
      itemId: input.itemId,
      mime: input.mime,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      data: bytes,
      createdBy: input.userId,
      createdAt: now,
    },
  });
  return { ok: true, value: { id: row.id } };
}

/** Removes a photo from a draft visit. */
export async function removePhoto(
  db: PmDb,
  input: { orgId: string; runId: string; photoId: string },
): Promise<Result> {
  const run = await db.pmRun.findFirst({ where: { id: input.runId, orgId: input.orgId } });
  if (!run) return bad('No such visit');
  if (run.status === 'signed') return bad('A signed visit keeps its photos.');
  const photo = await db.pmPhoto.findFirst({
    where: { id: input.photoId, runId: run.id, orgId: input.orgId },
  });
  if (!photo) return bad('No such photo');
  await db.pmPhoto.delete({ where: { id: photo.id } });
  return { ok: true, value: { id: photo.id } };
}

/** What photos a visit has, without the pictures themselves. */
export async function listPhotos(db: PmDb, orgId: string, runId: string): Promise<PmPhotoView[]> {
  const rows = await db.pmPhoto.findMany({
    where: { orgId, runId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, itemId: true, mime: true, size: true, sha256: true, createdAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    itemId: r.itemId,
    mime: r.mime,
    size: r.size,
    sha256: r.sha256,
    createdAt: r.createdAt,
  }));
}

/** One picture, as a data address the page can show. */
export async function getPhoto(
  db: PmDb,
  input: { orgId: string; runId: string; photoId: string },
): Promise<Result<{ dataUrl: string }>> {
  const photo = await db.pmPhoto.findFirst({
    where: { id: input.photoId, runId: input.runId, orgId: input.orgId },
  });
  if (!photo) return bad('No such photo');
  return {
    ok: true,
    value: { dataUrl: `data:${photo.mime};base64,${Buffer.from(photo.data).toString('base64')}` },
  };
}

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
  if (await db.pmSchedule.findFirst({ where: { templateId, orgId, enabled: true } }))
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

// ---- Scope: one room or device, several rooms, an area or a whole site ----------------------------

/** room: one room or device. rooms, area, site: a visit with a segment for each room in scope. */
export const PM_SCOPES = ['room', 'rooms', 'area', 'site'] as const;
export type PmScope = (typeof PM_SCOPES)[number];

export interface ScopeInput {
  scope: PmScope;
  siteId?: string | null;
  areaId?: string | null;
  roomIds?: string[] | null;
}

export interface ScopeRooms {
  rooms: { id: string; name: string; siteId: string }[];
  /** What the visit covers, in words: "Site: Head office", "Level 2", "3 rooms". */
  label: string;
  siteId: string | null;
}

/** The rooms a multi-room scope covers right now (ordinary rooms only, not the combined spaces). */
export async function roomsInScope(
  db: PmDb,
  orgId: string,
  s: ScopeInput,
): Promise<Result<ScopeRooms>> {
  const pick = (r: { id: string; name: string; siteId: string }) => ({
    id: r.id,
    name: r.name,
    siteId: r.siteId,
  });
  const byName = <T extends { name: string }>(l: T[]) =>
    [...l].sort((a, b) => a.name.localeCompare(b.name));
  if (s.scope === 'site') {
    if (!s.siteId) return bad('Choose a site');
    const site = await db.site.findFirst({ where: { id: s.siteId, orgId } });
    if (!site) return bad('No such site');
    const rooms = await db.room.findMany({
      where: { orgId, siteId: site.id, kind: 'standard' },
    });
    return {
      ok: true,
      value: { rooms: byName(rooms.map(pick)), label: `Site: ${site.name}`, siteId: site.id },
    };
  }
  if (s.scope === 'area') {
    if (!s.areaId) return bad('Choose an area');
    const area = await db.area.findFirst({ where: { id: s.areaId, orgId } });
    if (!area) return bad('No such area');
    // The area and everything inside it.
    const all = await db.area.findMany({ where: { orgId, siteId: area.siteId } });
    const ids = new Set([area.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const a of all)
        if (a.parentId && ids.has(a.parentId) && !ids.has(a.id)) {
          ids.add(a.id);
          grew = true;
        }
    }
    const rooms = await db.room.findMany({
      where: { orgId, areaId: { in: [...ids] }, kind: 'standard' },
    });
    return {
      ok: true,
      value: { rooms: byName(rooms.map(pick)), label: `Area: ${area.name}`, siteId: area.siteId },
    };
  }
  if (s.scope === 'rooms') {
    const want = [...new Set(s.roomIds ?? [])];
    if (want.length < 2) return bad('Choose at least two rooms, or use a single room schedule');
    const rooms = await db.room.findMany({ where: { orgId, id: { in: want }, kind: 'standard' } });
    if (rooms.length !== want.length) return bad('One of those rooms no longer exists');
    const sites = new Set(rooms.map((r) => r.siteId));
    return {
      ok: true,
      value: {
        rooms: byName(rooms.map(pick)),
        label: `${rooms.length} rooms`,
        siteId: sites.size === 1 ? [...sites][0]! : null,
      },
    };
  }
  return bad('Choose rooms, an area or a site');
}

/** The rooms or devices a visit will check: one segment each. */
async function segmentTargets(
  db: PmDb,
  orgId: string,
  template: { appliesTo: string; category: string | null },
  rooms: ScopeRooms['rooms'],
): Promise<
  { roomId: string; roomName: string; deviceId: string | null; deviceName: string | null }[]
> {
  if (template.appliesTo === 'room')
    return rooms.map((r) => ({ roomId: r.id, roomName: r.name, deviceId: null, deviceName: null }));
  const devices = await db.device.findMany({
    where: { orgId, roomId: { in: rooms.map((r) => r.id) }, kind: 'active' },
  });
  return devices
    .filter((d) => !template.category || d.category === template.category)
    .flatMap((d) => {
      const room = rooms.find((r) => r.id === d.roomId);
      return room
        ? [{ roomId: room.id, roomName: room.name, deviceId: d.id, deviceName: d.name }]
        : [];
    })
    .sort(
      (a, b) =>
        a.roomName.localeCompare(b.roomName) ||
        (a.deviceName ?? '').localeCompare(b.deviceName ?? ''),
    );
}

/** The scope a stored schedule covers, as a ScopeInput. */
const scopeOf = (s: {
  scope?: string | null;
  siteId?: string | null;
  areaId?: string | null;
  roomIds?: string[] | null;
}): ScopeInput => ({
  scope: (s.scope ?? 'room') as PmScope,
  siteId: s.siteId ?? null,
  areaId: s.areaId ?? null,
  roomIds: s.roomIds ?? [],
});

// ---- Schedules -----------------------------------------------------------------------------------

export async function createSchedule(
  db: PmDb,
  input: {
    orgId: string;
    templateId: string;
    roomId?: string | null;
    deviceId?: string | null;
    /** Several rooms, an area or a site: one visit with a segment for each room. Default: one room or device. */
    scope?: PmScope;
    siteId?: string | null;
    areaId?: string | null;
    roomIds?: string[] | null;
    /** Ignored for a one-time check. */
    intervalDays: number;
    /** Done once, then it switches itself off, instead of coming round again. */
    oneOff?: boolean;
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
  const oneOff = input.oneOff === true;
  const intervalDays = oneOff ? 0 : input.intervalDays;
  if (!oneOff && (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 1095))
    return bad('Choose an interval between 1 day and 3 years');
  const scope = input.scope ?? 'room';
  if (scope !== 'room') {
    const covered = await roomsInScope(db, input.orgId, { ...input, scope });
    if (!covered.ok) return covered;
    const targets = await segmentTargets(db, input.orgId, template, covered.value.rooms);
    if (targets.length === 0)
      return bad(
        template.appliesTo === 'room'
          ? 'There are no rooms there to check'
          : 'There are no matching devices in those rooms',
      );
    const row = await db.pmSchedule.create({
      data: {
        orgId: input.orgId,
        templateId: template.id,
        roomId: null,
        deviceId: null,
        scope,
        siteId: scope === 'site' ? (input.siteId ?? null) : null,
        areaId: scope === 'area' ? (input.areaId ?? null) : null,
        roomIds: scope === 'rooms' ? [...new Set(input.roomIds ?? [])] : [],
        intervalDays,
        oneOff,
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
      intervalDays,
      oneOff,
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
  /** A one-time check, switched off once done. */
  oneOff: boolean;
  nextDueOn: Date;
  leadDays: number;
  assigneeUserId: string | null;
  assigneeMspOrgId: string | null;
  enabled: boolean;
  lastRunOn: Date | null;
  state: DueState;
  scope: PmScope;
  /** For a multi-room schedule: what it covers, how many rooms, and which. */
  scopeLabel: string | null;
  roomCount: number | null;
  scopeRoomIds: string[];
  /** A visit started from this schedule and not yet signed, so the page offers Continue. */
  openRunId: string | null;
}

export async function listSchedules(
  db: PmDb,
  orgId: string,
  now = new Date(),
  filter: { roomId?: string; deviceId?: string } = {},
): Promise<ScheduleView[]> {
  const [all, templates, drafts] = await Promise.all([
    db.pmSchedule.findMany({
      where: {
        orgId,
        ...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
      },
      orderBy: { nextDueOn: 'asc' },
    }),
    db.pmTemplate.findMany({ where: { orgId } }),
    db.pmRun.findMany({
      where: { orgId, status: 'draft', parentRunId: null, scheduleId: { not: null } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  // What each multi-room schedule covers today.
  const covers = new Map<string, ScopeRooms>();
  for (const s of all.filter((x) => (x.scope ?? 'room') !== 'room')) {
    const c = await roomsInScope(db, orgId, scopeOf(s));
    if (c.ok) covers.set(s.id, c.value);
  }
  const rows = all
    .filter((s) => !(s.oneOff === true && !s.enabled))
    .filter((s) => {
      if (!filter.roomId) return true;
      if ((s.scope ?? 'room') === 'room') return s.roomId === filter.roomId;
      return covers.get(s.id)?.rooms.some((r) => r.id === filter.roomId) ?? false;
    });
  return rows.map((s) => ({
    scope: s.scope as PmScope,
    scopeLabel: covers.get(s.id)?.label ?? null,
    roomCount: covers.get(s.id)?.rooms.length ?? null,
    scopeRoomIds: covers.get(s.id)?.rooms.map((r) => r.id) ?? [],
    openRunId: drafts.find((d) => d.scheduleId === s.id)?.id ?? null,
    id: s.id,
    templateId: s.templateId,
    templateName: templates.find((t) => t.id === s.templateId)?.name ?? 'Removed checklist',
    roomId: s.roomId,
    deviceId: s.deviceId,
    intervalDays: s.intervalDays,
    oneOff: s.oneOff === true,
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

/** The answers a fresh visit to a room or device starts with: what monitoring can say is filled in. */
async function freshResults(
  db: PmDb,
  orgId: string,
  items: PmItem[],
  target: { roomId: string | null; deviceId: string | null },
  now: Date,
): Promise<PmResult[]> {
  const results: PmResult[] = [];
  for (const i of items) {
    const answer = i.auto ? await autoAnswer(db, orgId, i.auto, target) : null;
    results.push({
      itemId: i.id,
      label: i.label,
      type: i.type,
      result: answer ? answer.result : null,
      ...(answer ? { auto: { value: answer.value, at: now.toISOString() } } : {}),
    });
  }
  return results;
}

/**
 * Starts a visit: a draft run with everything monitoring can answer already filled in. A schedule (or
 * a request) for several rooms, an area or a site starts one parent visit with a segment for each room.
 */
export async function startRun(
  db: PmDb,
  input: {
    orgId: string;
    templateId: string;
    scheduleId?: string | null;
    roomId?: string | null;
    deviceId?: string | null;
    scope?: PmScope;
    siteId?: string | null;
    areaId?: string | null;
    roomIds?: string[] | null;
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
  const scope: ScopeInput = schedule
    ? scopeOf(schedule)
    : {
        scope: input.scope ?? 'room',
        siteId: input.siteId,
        areaId: input.areaId,
        roomIds: input.roomIds,
      };
  if (scope.scope !== 'room') return startMultiRun(db, input, template, schedule, scope, now);
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
  const results = await freshResults(
    db,
    input.orgId,
    parseItems(template.items),
    { roomId, deviceId },
    now,
  );
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

async function startMultiRun(
  db: PmDb,
  input: { orgId: string; scheduleId?: string | null; userId: string | null },
  template: {
    id: string;
    name: string;
    version: number;
    appliesTo: string;
    category: string | null;
    items: unknown;
  },
  schedule: { id: string; nextDueOn: Date } | null,
  scope: ScopeInput,
  now: Date,
): Promise<Result> {
  // One open visit per schedule: asking again goes back to it.
  if (schedule) {
    const open = await db.pmRun.findFirst({
      where: { orgId: input.orgId, scheduleId: schedule.id, status: 'draft', parentRunId: null },
    });
    if (open) return { ok: true, value: { id: open.id } };
  }
  const covered = await roomsInScope(db, input.orgId, scope);
  if (!covered.ok) return covered;
  const targets = await segmentTargets(db, input.orgId, template, covered.value.rooms);
  if (targets.length === 0)
    return bad(
      template.appliesTo === 'room'
        ? 'There are no rooms there to check'
        : 'There are no matching devices in those rooms',
    );
  const items = parseItems(template.items);
  const parent = await db.pmRun.create({
    data: {
      orgId: input.orgId,
      scheduleId: schedule?.id ?? null,
      templateId: template.id,
      templateName: template.name,
      templateVersion: template.version,
      roomId: null,
      deviceId: null,
      status: 'draft',
      results: [] as unknown as Prisma.InputJsonValue,
      failedCount: 0,
      dueOn: schedule?.nextDueOn ?? null,
      startedBy: input.userId,
      createdAt: now,
      multi: true,
      scopeLabel: covered.value.label,
      siteId: covered.value.siteId,
    },
  });
  // The rooms are fixed now: a room added later joins the next round, not this one.
  for (const t of targets) {
    const results = await freshResults(db, input.orgId, items, t, now);
    await db.pmRun.create({
      data: {
        orgId: input.orgId,
        scheduleId: null,
        templateId: template.id,
        templateName: template.name,
        templateVersion: template.version,
        roomId: t.roomId,
        deviceId: t.deviceId,
        status: 'draft',
        results: results as unknown as Prisma.InputJsonValue,
        failedCount: 0,
        dueOn: null,
        startedBy: input.userId,
        createdAt: now,
        parentRunId: parent.id,
        siteId: covered.value.siteId,
      },
    });
  }
  return { ok: true, value: { id: parent.id } };
}

/** Saves answers to a draft. A signed run is never edited. */
export async function saveRun(
  db: PmDb,
  input: {
    orgId: string;
    runId: string;
    results: unknown;
    notes?: string | null;
    /** Who is saving, so a visit with several rooms shows who worked on each. */
    userId?: string | null;
    userName?: string | null;
  },
): Promise<Result> {
  const run = await db.pmRun.findFirst({ where: { id: input.runId, orgId: input.orgId } });
  if (!run) return bad('No such visit');
  if (run.status === 'signed')
    return bad('A signed visit cannot be changed. Start a new one to correct it.');
  if (run.multi) return bad('Save the answers room by room.');
  if (run.status === 'skipped') return bad('This room was skipped. Bring it back to fill it in.');
  const parent = run.parentRunId
    ? await db.pmRun.findFirst({ where: { id: run.parentRunId, orgId: input.orgId } })
    : null;
  if (parent?.status === 'signed') return bad('That visit has been signed off.');
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
      ...(parent && input.userId
        ? { workedBy: input.userId, workedByName: input.userName ?? null }
        : {}),
    },
  });
  if (parent) await refreshParentFailed(db, input.orgId, parent.id);
  return { ok: true, value: { id: run.id } };
}

/** A visit to several rooms counts the failed items of all its rooms. */
async function refreshParentFailed(db: PmDb, orgId: string, parentId: string) {
  const rooms = await db.pmRun.findMany({ where: { orgId, parentRunId: parentId } });
  await db.pmRun.update({
    where: { id: parentId },
    data: { failedCount: rooms.reduce((n, c) => n + c.failedCount, 0) },
  });
}

/** Marks one room of a visit as not done, with the reason, so one locked room does not hold up the rest. */
export async function skipSegment(
  db: PmDb,
  input: { orgId: string; runId: string; reason: string },
): Promise<Result> {
  const reason = input.reason.trim();
  if (reason.length < 3) return bad('Say why it was skipped.');
  if (reason.length > 300) return bad('Keep the reason under 300 characters.');
  const run = await db.pmRun.findFirst({ where: { id: input.runId, orgId: input.orgId } });
  if (!run?.parentRunId) return bad('Only a room in a multi-room visit can be skipped.');
  if (run.status !== 'draft') return bad('That room is not open to skip.');
  const parent = await db.pmRun.findFirst({ where: { id: run.parentRunId, orgId: input.orgId } });
  if (parent?.status !== 'draft') return bad('That visit has been signed off.');
  await db.pmRun.update({
    where: { id: run.id },
    data: { status: 'skipped', skipReason: reason, failedCount: 0 },
  });
  await refreshParentFailed(db, input.orgId, parent.id);
  return { ok: true, value: { id: run.id } };
}

/** Brings a skipped room back into the visit. */
export async function unskipSegment(
  db: PmDb,
  input: { orgId: string; runId: string },
): Promise<Result> {
  const run = await db.pmRun.findFirst({ where: { id: input.runId, orgId: input.orgId } });
  if (!run?.parentRunId || run.status !== 'skipped') return bad('That room was not skipped.');
  const parent = await db.pmRun.findFirst({ where: { id: run.parentRunId, orgId: input.orgId } });
  if (parent?.status !== 'draft') return bad('That visit has been signed off.');
  const items = parseItems(
    (await db.pmTemplate.findFirst({ where: { id: run.templateId, orgId: input.orgId } }))?.items,
  );
  const results = PmResult.array().catch([]).parse(run.results);
  await db.pmRun.update({
    where: { id: run.id },
    data: { status: 'draft', skipReason: null, failedCount: countFailed(items, results) },
  });
  await refreshParentFailed(db, input.orgId, parent.id);
  return { ok: true, value: { id: run.id } };
}

type SignInput = {
  orgId: string;
  runId: string;
  userId: string | null;
  name: string;
  raiseTicket: boolean;
  markInRepair: boolean;
};

/**
 * Signs one room or device's answers: the ticket for what failed, the device's repair status and
 * history, and the record itself. `corrects` is the signed visit this one replaces, if any.
 */
async function finishOne(
  db: PmDb,
  run: {
    id: string;
    roomId: string | null;
    deviceId: string | null;
    templateName: string;
  },
  items: PmItem[],
  results: PmResult[],
  input: SignInput,
  now: Date,
  corrects: string | null,
): Promise<{ failed: number; ticketId: string | null }> {
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
        // A correction is its own entry, so the device history does not count the visit twice.
        type: corrects ? 'pm_corrected' : failed ? 'pm_failed' : 'pm_passed',
        source: 'manual',
        actorId: input.userId,
        data: {
          runId: run.id,
          template: run.templateName,
          failed,
          ...(corrects ? { corrects } : {}),
        } as Prisma.InputJsonValue,
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
  return { failed, ticketId };
}

/** Names the room (and device) of a segment for a message. */
async function segmentName(
  db: PmDb,
  orgId: string,
  c: { roomId: string | null; deviceId: string | null },
): Promise<string> {
  const [room, device] = await Promise.all([
    c.roomId ? db.room.findFirst({ where: { id: c.roomId, orgId } }) : null,
    c.deviceId ? db.device.findFirst({ where: { id: c.deviceId, orgId } }) : null,
  ]);
  return [room?.name, device?.name].filter(Boolean).join(' · ') || 'A room';
}

/**
 * Signs a visit off: it can no longer change. Failed items can raise one ticket for the room or
 * device and put a failed device's asset record in repair, and the schedule moves on. A visit to
 * several rooms is signed once for all of them: every room is answered (or skipped with a reason),
 * each room keeps its own ticket and device history, and the schedule moves on once.
 */
export async function signRun(
  db: PmDb,
  input: SignInput,
  now = new Date(),
): Promise<Result<{ id: string; failed: number; ticketId: string | null; tickets: number }>> {
  const run = await db.pmRun.findFirst({ where: { id: input.runId, orgId: input.orgId } });
  if (!run) return bad('No such visit');
  if (run.status === 'signed') return bad('This visit is already signed off');
  if (run.parentRunId) return bad('Sign off the whole visit, not one room.');
  if (!input.name.trim()) return bad('Type your name to sign it off');
  const template = await db.pmTemplate.findFirst({
    where: { id: run.templateId, orgId: input.orgId },
  });
  const items = parseItems(template?.items);

  let failed = 0;
  const tickets: string[] = [];
  if (run.multi) {
    const children = await db.pmRun.findMany({
      where: { orgId: input.orgId, parentRunId: run.id },
      orderBy: { createdAt: 'asc' },
    });
    const active = children.filter((c) => c.status === 'draft');
    if (active.length === 0) return bad('Every room was skipped. Discard the visit instead.');
    const problems: string[] = [];
    for (const c of active) {
      const missing = unanswered(items, PmResult.array().catch([]).parse(c.results));
      if (missing.length)
        problems.push(
          `${await segmentName(db, input.orgId, c)}: ${missing.slice(0, 2).join(', ')}${missing.length > 2 ? ` and ${missing.length - 2} more` : ''}`,
        );
    }
    if (problems.length)
      return bad(
        `Still to answer in ${problems.length} room${problems.length === 1 ? '' : 's'}: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` and ${problems.length - 3} more` : ''}`,
      );
    for (const c of active) {
      const r = await finishOne(
        db,
        c,
        items,
        PmResult.array().catch([]).parse(c.results),
        input,
        now,
        run.correctsRunId,
      );
      failed += r.failed;
      if (r.ticketId) tickets.push(r.ticketId);
    }
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
  } else {
    const results = PmResult.array().catch([]).parse(run.results);
    const missing = unanswered(items, results);
    if (missing.length)
      return bad(
        `Still to answer: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}`,
      );
    const r = await finishOne(db, run, items, results, input, now, run.correctsRunId);
    failed = r.failed;
    if (r.ticketId) tickets.push(r.ticketId);
  }
  if (run.scheduleId) {
    const s = await db.pmSchedule.findFirst({ where: { id: run.scheduleId, orgId: input.orgId } });
    if (s) {
      await db.pmSchedule.update({
        where: { id: s.id },
        data:
          s.oneOff === true
            ? // A one-time check is done: it switches itself off and leaves the list.
              { enabled: false, lastRunOn: toDay(now) }
            : {
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
  return {
    ok: true,
    value: { id: run.id, failed, ticketId: tickets[0] ?? null, tickets: tickets.length },
  };
}

/** Removes a draft that was started by mistake (every room of it, with their photos). A signed visit is never removed. */
export async function discardRun(db: PmDb, orgId: string, runId: string): Promise<Result> {
  const run = await db.pmRun.findFirst({ where: { id: runId, orgId } });
  if (!run) return bad('No such visit');
  if (run.status === 'signed') return bad('A signed visit cannot be removed');
  if (run.parentRunId) return bad('Discard the whole visit, not one room.');
  const rooms = run.multi ? await db.pmRun.findMany({ where: { orgId, parentRunId: run.id } }) : [];
  await db.pmPhoto.deleteMany({
    where: { orgId, runId: { in: [run.id, ...rooms.map((c) => c.id)] } },
  });
  if (rooms.length) await db.pmRun.deleteMany({ where: { orgId, parentRunId: run.id } });
  await db.pmRun.delete({ where: { id: runId } });
  return { ok: true, value: { id: runId } };
}

/** Answers carry over for items still on the checklist; anything new starts empty. */
function carryOver(items: PmItem[], orig: unknown): PmResult[] {
  const before = new Map(
    PmResult.array()
      .catch([])
      .parse(orig)
      .map((r) => [r.itemId, r]),
  );
  return items.map((i) => {
    const o = before.get(i.id);
    return o
      ? { ...o, label: i.label, type: i.type }
      : { itemId: i.id, label: i.label, type: i.type, result: null };
  });
}

async function copyPhotos(
  db: PmDb,
  orgId: string,
  fromRunId: string,
  toRunId: string,
  items: PmItem[],
  userId: string | null,
  now: Date,
) {
  const keep = new Set(items.filter((i) => i.type === 'photo').map((i) => i.id));
  const photos = await db.pmPhoto.findMany({ where: { orgId, runId: fromRunId } });
  for (const p of photos.filter((x) => keep.has(x.itemId)))
    await db.pmPhoto.create({
      data: {
        orgId,
        runId: toRunId,
        itemId: p.itemId,
        mime: p.mime,
        size: p.size,
        sha256: p.sha256,
        data: p.data,
        createdBy: userId,
        createdAt: now,
      },
    });
}

/**
 * A signed visit is never edited. To fix a mistake, someone starts a correction: a new draft with the
 * answers and photos copied across and the reason recorded, linked to the original. Signing it leaves
 * both on record, and reports count the correction in place of the original. One correction is open at
 * a time; asking again returns it. A visit to several rooms is corrected as a whole: every room is
 * copied across (a skipped room stays skipped until someone brings it back).
 */
export async function correctRun(
  db: PmDb,
  input: { orgId: string; runId: string; userId: string | null; reason: string },
  now = new Date(),
): Promise<Result<{ id: string; existing: boolean }>> {
  const reason = input.reason.trim();
  if (reason.length < 5) return bad('Say why it needs correcting (at least 5 characters).');
  if (reason.length > 500) return bad('Keep the reason under 500 characters.');
  const orig = await db.pmRun.findFirst({ where: { id: input.runId, orgId: input.orgId } });
  if (!orig) return bad('No such visit');
  if (orig.parentRunId) return bad('Correct the whole visit, not one room of it.');
  if (orig.status !== 'signed')
    return bad('Only a signed visit needs a correction. Edit the draft instead.');
  const open = await db.pmRun.findFirst({
    where: { orgId: input.orgId, correctsRunId: orig.id, status: 'draft' },
  });
  if (open) return { ok: true, value: { id: open.id, existing: true } };
  const template = await db.pmTemplate.findFirst({
    where: { id: orig.templateId, orgId: input.orgId },
  });
  if (!template)
    return bad('The checklist for this visit has been deleted, so it cannot be corrected.');
  const items = parseItems(template.items);
  const run = await db.pmRun.create({
    data: {
      orgId: input.orgId,
      // No schedule: the original already moved it on.
      scheduleId: null,
      templateId: template.id,
      templateName: template.name,
      templateVersion: template.version,
      roomId: orig.roomId,
      deviceId: orig.deviceId,
      status: 'draft',
      results: (orig.multi
        ? []
        : carryOver(items, orig.results)) as unknown as Prisma.InputJsonValue,
      failedCount: 0,
      dueOn: null,
      notes: orig.notes,
      startedBy: input.userId,
      createdAt: now,
      correctsRunId: orig.id,
      correctionReason: reason,
      multi: orig.multi,
      scopeLabel: orig.scopeLabel,
      siteId: orig.siteId,
    },
  });
  if (!orig.multi) {
    await copyPhotos(db, input.orgId, orig.id, run.id, items, input.userId, now);
  } else {
    const rooms = await db.pmRun.findMany({
      where: { orgId: input.orgId, parentRunId: orig.id },
      orderBy: { createdAt: 'asc' },
    });
    for (const c of rooms) {
      const copy = await db.pmRun.create({
        data: {
          orgId: input.orgId,
          scheduleId: null,
          templateId: template.id,
          templateName: template.name,
          templateVersion: template.version,
          roomId: c.roomId,
          deviceId: c.deviceId,
          status: c.status === 'skipped' ? 'skipped' : 'draft',
          skipReason: c.status === 'skipped' ? c.skipReason : null,
          results: carryOver(items, c.results) as unknown as Prisma.InputJsonValue,
          failedCount: 0,
          dueOn: null,
          notes: c.notes,
          startedBy: input.userId,
          createdAt: now,
          parentRunId: run.id,
          siteId: c.siteId,
        },
      });
      await copyPhotos(db, input.orgId, c.id, copy.id, items, input.userId, now);
    }
  }
  return { ok: true, value: { id: run.id, existing: false } };
}

/** The visits that correct a signed visit (newest first), so the original can say it was corrected. */
export async function correctionsOf(db: PmDb, orgId: string, runId: string) {
  return db.pmRun.findMany({
    where: { orgId, correctsRunId: runId },
    orderBy: { createdAt: 'desc' },
  });
}

// ---- Records: the list of visits, grouped by site, and what is exported --------------------------

export interface PmSegmentView {
  id: string;
  roomId: string | null;
  roomName: string | null;
  deviceId: string | null;
  deviceName: string | null;
  /** draft, signed or skipped. */
  status: string;
  failedCount: number;
  skipReason: string | null;
  workedByName: string | null;
}

export interface PmVisitView {
  id: string;
  templateName: string;
  status: string;
  failedCount: number;
  roomId: string | null;
  roomName: string | null;
  deviceId: string | null;
  deviceName: string | null;
  siteId: string | null;
  siteName: string | null;
  signedAt: Date | null;
  signedByName: string | null;
  dueOn: Date | null;
  createdAt: Date;
  correctsRunId: string | null;
  /** A visit to several rooms: what it covers and each room as a segment. */
  multi: boolean;
  scopeLabel: string | null;
  segments: PmSegmentView[];
  /** Set when this row is one room of a multi-room visit (shown on that room's own record). */
  parentRunId: string | null;
  parentLabel: string | null;
}

/**
 * Visits, newest first. The organisation's list has one row per visit (a visit to several rooms is
 * one row with a segment for each room). A room's or device's list also has the segments that
 * belong to it, each pointing at its visit.
 */
export async function listRuns(
  db: PmDb,
  orgId: string,
  filter: {
    runId?: string;
    roomId?: string;
    deviceId?: string;
    status?: 'draft' | 'signed';
    failedOnly?: boolean;
    limit?: number;
  } = {},
  /** The rooms a site-limited reader may see, or null for everything. */
  roomIds: Set<string> | null = null,
): Promise<PmVisitView[]> {
  const forOne = !!(filter.roomId || filter.deviceId);
  const [rows, rooms, devices, sites] = await Promise.all([
    db.pmRun.findMany({
      where: {
        orgId,
        ...(filter.runId ? { id: filter.runId } : {}),
        ...(forOne || filter.runId ? {} : { parentRunId: null }),
        ...(filter.roomId ? { roomId: filter.roomId } : {}),
        ...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: filter.limit ?? 100,
    }),
    db.room.findMany({ where: { orgId }, select: { id: true, name: true, siteId: true } }),
    db.device.findMany({ where: { orgId }, select: { id: true, name: true, roomId: true } }),
    db.site.findMany({ where: { orgId }, select: { id: true, name: true } }),
  ]);
  const ids = rows.filter((r) => r.multi).map((r) => r.id);
  const kids = ids.length
    ? await db.pmRun.findMany({
        where: { orgId, parentRunId: { in: ids } },
        orderBy: { createdAt: 'asc' },
      })
    : [];
  const parents = forOne
    ? await db.pmRun.findMany({
        where: {
          orgId,
          id: { in: rows.flatMap((r) => (r.parentRunId ? [r.parentRunId] : [])) },
        },
      })
    : [];
  const roomOf = (id: string | null) => rooms.find((x) => x.id === id);
  const deviceOf = (id: string | null) => devices.find((x) => x.id === id);
  const visible = (roomId: string | null) =>
    roomIds === null || (roomId !== null && roomIds.has(roomId));
  const views: PmVisitView[] = [];
  for (const r of rows) {
    const segments: PmSegmentView[] = kids
      .filter((k) => k.parentRunId === r.id && visible(k.roomId))
      .map((k) => ({
        id: k.id,
        roomId: k.roomId,
        roomName: roomOf(k.roomId)?.name ?? null,
        deviceId: k.deviceId,
        deviceName: deviceOf(k.deviceId)?.name ?? null,
        status: k.status,
        failedCount: k.failedCount,
        skipReason: k.skipReason,
        workedByName: k.workedByName,
      }));
    if (r.multi ? segments.length === 0 : !visible(r.roomId)) continue;
    if (filter.failedOnly && r.failedCount === 0) continue;
    const room = roomOf(r.roomId) ?? roomOf(deviceOf(r.deviceId)?.roomId ?? null);
    const siteId = r.siteId ?? room?.siteId ?? null;
    views.push({
      id: r.id,
      templateName: r.templateName,
      status: r.status,
      failedCount: r.failedCount,
      roomId: r.roomId,
      roomName: roomOf(r.roomId)?.name ?? null,
      deviceId: r.deviceId,
      deviceName: deviceOf(r.deviceId)?.name ?? null,
      siteId,
      siteName: sites.find((x) => x.id === siteId)?.name ?? null,
      signedAt: r.signedAt,
      signedByName: r.signedByName,
      dueOn: r.dueOn,
      createdAt: r.createdAt,
      correctsRunId: r.correctsRunId,
      multi: r.multi === true,
      scopeLabel: r.scopeLabel ?? null,
      segments,
      parentRunId: r.parentRunId,
      parentLabel: r.parentRunId
        ? (parents.find((p) => p.id === r.parentRunId)?.scopeLabel ?? null)
        : null,
    });
  }
  return views;
}

export interface PmExportPhoto {
  id: string;
  itemId: string;
  /** The checklist item it was taken for. */
  itemLabel: string;
  mime: string;
  size: number;
  sha256: string;
  createdAt: Date;
}

export interface PmExportSection {
  /** The run the answers and photos belong to (the room's own run in a multi-room visit). */
  runId: string;
  room: string | null;
  device: string | null;
  status: string;
  failedCount: number;
  skipReason: string | null;
  workedByName: string | null;
  results: {
    itemId: string;
    type: string;
    label: string;
    result: string | number | null;
    note: string | null;
    kestrelSaw: string | null;
  }[];
  photos: PmExportPhoto[];
}

export interface PmExportVisit extends PmVisitView {
  notes: string | null;
  /** One section for a single visit, one per room for a multi-room visit. */
  sections: PmExportSection[];
}

/** Visits with every answer, for the CSV and the printable PDF. */
export async function exportVisits(
  db: PmDb,
  orgId: string,
  filter: Parameters<typeof listRuns>[2],
  roomIds: Set<string> | null = null,
): Promise<PmExportVisit[]> {
  const visits = await listRuns(db, orgId, filter, roomIds);
  const want = visits.flatMap((v) => (v.multi ? v.segments.map((s) => s.id) : [v.id]));
  const runs = want.length ? await db.pmRun.findMany({ where: { orgId, id: { in: want } } }) : [];
  const answers = (id: string) =>
    PmResult.array()
      .catch([])
      .parse(runs.find((r) => r.id === id)?.results)
      .map((x) => ({
        itemId: x.itemId,
        type: x.type,
        label: x.label,
        result: x.result,
        note: x.note ?? null,
        kestrelSaw: x.auto?.value ?? null,
      }));
  // Photos by the run they were taken in, described without their bytes.
  const photoRows = want.length
    ? await db.pmPhoto.findMany({
        where: { orgId, runId: { in: want } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          runId: true,
          itemId: true,
          mime: true,
          size: true,
          sha256: true,
          createdAt: true,
        },
      })
    : [];
  const photosOf = (runId: string): PmExportPhoto[] => {
    const labels = new Map(answers(runId).map((a) => [a.itemId, a.label]));
    return photoRows
      .filter((p) => p.runId === runId)
      .map((p) => ({
        id: p.id,
        itemId: p.itemId,
        itemLabel: labels.get(p.itemId) ?? 'Photo',
        mime: p.mime,
        size: p.size,
        sha256: p.sha256,
        createdAt: p.createdAt,
      }));
  };
  const parentNotes = visits.some((v) => v.multi)
    ? await db.pmRun.findMany({ where: { orgId, id: { in: visits.map((v) => v.id) } } })
    : [];
  return visits.map((v) => ({
    ...v,
    notes:
      (runs.find((r) => r.id === v.id) ?? parentNotes.find((r) => r.id === v.id))?.notes ?? null,
    sections: v.multi
      ? v.segments.map((s) => ({
          runId: s.id,
          room: s.roomName,
          device: s.deviceName,
          status: s.status,
          failedCount: s.failedCount,
          skipReason: s.skipReason,
          workedByName: s.workedByName,
          results: s.status === 'skipped' ? [] : answers(s.id),
          photos: s.status === 'skipped' ? [] : photosOf(s.id),
        }))
      : [
          {
            runId: v.id,
            room: v.roomName,
            device: v.deviceName,
            status: v.status,
            failedCount: v.failedCount,
            skipReason: null,
            workedByName: null,
            results: answers(v.id),
            photos: photosOf(v.id),
          },
        ],
  }));
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
    // A visit to several rooms is one visit: its rooms are not counted again.
    db.pmRun.findMany({ where: { orgId, status: 'signed', parentRunId: null } }),
  ]);
  // A site-limited reader sees a multi-room schedule or visit when any of its rooms is theirs.
  const roomsOf = new Map<string, string[]>();
  if (roomIds !== null) {
    for (const s of schedules.filter((x) => (x.scope ?? 'room') !== 'room')) {
      const c = await roomsInScope(db, orgId, scopeOf(s));
      if (c.ok)
        roomsOf.set(
          s.id,
          c.value.rooms.map((r) => r.id),
        );
    }
    const kids = await db.pmRun.findMany({
      where: { orgId, status: 'signed', parentRunId: { not: null } },
    });
    for (const r of runs.filter((x) => x.multi))
      roomsOf.set(
        r.id,
        kids.filter((k) => k.parentRunId === r.id && k.roomId).map((k) => k.roomId!),
      );
  }
  const touches = (id: string) => (roomsOf.get(id) ?? []).some((x) => roomIds!.has(x));
  const inScope = (s: { id: string; scope: string; roomId: string | null }) =>
    roomIds === null ||
    ((s.scope ?? 'room') === 'room' ? s.roomId !== null && roomIds.has(s.roomId) : touches(s.id));
  const mine = schedules.filter(inScope);
  const states = mine.map((s) => dueState(s.nextDueOn, s.leadDays, now));
  const yearAgo = now.getTime() - 365 * 86_400_000;
  const recent = runs.filter(
    (r) =>
      r.dueOn &&
      r.signedAt &&
      r.signedAt.getTime() >= yearAgo &&
      (roomIds === null || (r.multi ? touches(r.id) : r.roomId !== null && roomIds.has(r.roomId))),
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
  /** SHA-256 of each photo taken, so the signature covers them. */
  photos?: { itemId: string; sha256: string }[];
  /** This visit corrects an earlier signed one. */
  corrects?: string;
  correctionReason?: string;
  /** A later signed visit replaces this one; it is listed but not counted. */
  supersededBy?: string;
  /** A visit to several rooms: what it covered, and each room's own answers. */
  scope?: string;
  segments?: PmReportSegment[];
}

export interface PmReportSegment {
  room: string | null;
  device: string | null;
  /** signed, or skipped with a reason. */
  status: string;
  skipReason?: string;
  workedBy?: string;
  failed: number;
  results: { label: string; result: string | number | null; note?: string }[];
  photos?: { itemId: string; sha256: string }[];
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
  const [runs, rooms, devices, last, photoRows] = await Promise.all([
    db.pmRun.findMany({
      where: { orgId: input.orgId, status: 'signed', parentRunId: null },
      orderBy: { signedAt: 'asc' },
    }),
    db.room.findMany({ where: { orgId: input.orgId } }),
    db.device.findMany({ where: { orgId: input.orgId } }),
    db.registerIssue.findMany({
      where: { orgId: input.orgId, kind: 'pm_report' },
      orderBy: { number: 'desc' },
    }),
    db.pmPhoto.findMany({
      where: { orgId: input.orgId },
      select: { runId: true, itemId: true, sha256: true },
    }),
  ]);
  const kids = await db.pmRun.findMany({
    where: { orgId: input.orgId, parentRunId: { not: null } },
    orderBy: { createdAt: 'asc' },
  });
  const answers = (raw: unknown) =>
    (PmResult.array().catch([]).parse(raw) ?? []).map((x) => ({
      label: x.label,
      result: x.result,
      ...(x.note ? { note: x.note } : {}),
    }));
  const photosOf = (id: string) =>
    photoRows.filter((p) => p.runId === id).map((p) => ({ itemId: p.itemId, sha256: p.sha256 }));
  const supersededBy = new Map<string, string>();
  for (const r of runs) if (r.correctsRunId) supersededBy.set(r.correctsRunId, r.id);
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
    results: answers(r.results),
    ...(photoRows.some((p) => p.runId === r.id) ? { photos: photosOf(r.id) } : {}),
    ...(r.multi
      ? {
          scope: r.scopeLabel ?? undefined,
          segments: kids
            .filter((k) => k.parentRunId === r.id)
            .map((k) => ({
              room: rooms.find((x) => x.id === k.roomId)?.name ?? null,
              device: devices.find((x) => x.id === k.deviceId)?.name ?? null,
              status: k.status,
              ...(k.skipReason ? { skipReason: k.skipReason } : {}),
              ...(k.workedByName ? { workedBy: k.workedByName } : {}),
              failed: k.failedCount,
              results: answers(k.results),
              ...(photoRows.some((p) => p.runId === k.id) ? { photos: photosOf(k.id) } : {}),
            })),
        }
      : {}),
    ...(r.correctsRunId
      ? { corrects: r.correctsRunId, correctionReason: r.correctionReason ?? undefined }
      : {}),
    ...(supersededBy.has(r.id) ? { supersededBy: supersededBy.get(r.id) } : {}),
  }));
  const number = (last[0]?.number ?? 0) + 1;
  // A visit that was corrected is listed, but the correction is what counts.
  const counted = rows.filter((r) => !r.supersededBy);
  const withDue = counted.filter((r) => r.onTime !== null);
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
      visits: counted.length,
      withFailures: counted.filter((r) => r.failed > 0).length,
      itemsFailed: counted.reduce((n, r) => n + r.failed, 0),
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
