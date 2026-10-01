import { signDocument, verifyDocument } from '@kestrel/crypto';
import type { Prisma, PrismaClient } from '@kestrel/db';
import { ASSET_FIELDS, assetCategoryLabel, type Provenance, type PublicKey } from '@kestrel/model';
import type { SigningKey } from './signing';

// Register issues (docs/pivot-monitoring.md, "Asset register"): a frozen, numbered, signed copy of
// the register (or of a maintenance report) that can be kept, handed over and checked later. The
// signature proves Kestrel issued exactly this content at that time; it does not prove that values
// people typed are true, so each row says which fields were read from the device and which were
// entered. Functions take the database as a parameter so they can be tested without one.
export type RegisterDb = Pick<
  PrismaClient,
  'device' | 'room' | 'site' | 'area' | 'org' | 'registerIssue' | 'registerSchedule'
>;

export const REGISTER_PURPOSE = 'register_issue';
export const PM_REPORT_PURPOSE = 'pm_report';

export interface RegisterRow {
  id: string;
  name: string;
  kind: string;
  category: string;
  categoryLabel: string;
  site: string;
  area: string;
  room: string;
  make: string | null;
  model: string | null;
  serial: string | null;
  mac: string | null;
  ip: string | null;
  firmware: string | null;
  assetTag: string | null;
  status: string;
  installedOn: string | null;
  warrantyEndsOn: string | null;
  endOfLifeOn: string | null;
  supplier: string | null;
  /** Where each recorded field came from: read from the device, or typed in. */
  sources: Record<string, 'discovered' | 'manual'>;
  /** Fields where a typed value and the device's own reading disagree. */
  mismatches: string[];
}

export type Scope = 'org' | 'site' | 'area';
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** The register as it stands, for the whole organisation, a site, or an area and everything inside it. */
export async function buildRegisterRows(
  db: RegisterDb,
  orgId: string,
  scope: Scope = 'org',
  scopeId: string | null = null,
): Promise<RegisterRow[]> {
  const [devices, rooms, sites, areas] = await Promise.all([
    db.device.findMany({ where: { orgId }, orderBy: { name: 'asc' } }),
    db.room.findMany({ where: { orgId } }),
    db.site.findMany({ where: { orgId } }),
    db.area.findMany({ where: { orgId } }),
  ]);
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const areaById = new Map(areas.map((a) => [a.id, a]));
  const areaPath = (id: string | null) => {
    const parts: string[] = [];
    for (let cur = id, guard = 0; cur && guard < 6; guard++) {
      const a = areaById.get(cur);
      if (!a) break;
      parts.unshift(a.name);
      cur = a.parentId;
    }
    return parts.join(' / ');
  };
  const inArea = (start: string | null): Set<string> => {
    const ids = new Set<string>();
    if (!start) return ids;
    ids.add(start);
    for (let grew = true; grew;) {
      grew = false;
      for (const a of areas)
        if (a.parentId && ids.has(a.parentId) && !ids.has(a.id)) {
          ids.add(a.id);
          grew = true;
        }
    }
    return ids;
  };
  const areaSet = scope === 'area' ? inArea(scopeId) : null;
  const out: RegisterRow[] = [];
  for (const d of devices) {
    const room = d.roomId ? roomById.get(d.roomId) : undefined;
    if (scope === 'site' && d.siteId !== scopeId) continue;
    if (scope === 'area' && !(room?.areaId && areaSet!.has(room.areaId))) continue;
    const prov = (d.provenance ?? {}) as Provenance;
    const sources: RegisterRow['sources'] = {};
    const mismatches: string[] = [];
    for (const f of ASSET_FIELDS) {
      const p = prov[f];
      if (p) sources[f] = p.source;
      if (p?.discovered) mismatches.push(f);
    }
    out.push({
      id: d.id,
      name: d.name,
      kind: d.kind,
      category: d.category,
      categoryLabel: assetCategoryLabel(d.category),
      site: siteName.get(d.siteId) ?? '',
      area: areaPath(room?.areaId ?? null),
      room: room?.name ?? '',
      make: d.make,
      model: d.model,
      serial: d.serial,
      mac: d.mac,
      ip: d.ip,
      firmware: d.firmware,
      assetTag: d.assetTag,
      status: d.status,
      installedOn: day(d.installedOn),
      warrantyEndsOn: day(d.warrantyEndsOn),
      endOfLifeOn: day(d.endOfLifeOn),
      supplier: d.supplier,
      sources,
      mismatches,
    });
  }
  return out;
}

export interface RowChange {
  id: string;
  name: string;
  fields: { field: string; before: string | null; after: string | null }[];
}
export interface RegisterDiff {
  added: { id: string; name: string }[];
  removed: { id: string; name: string }[];
  changed: RowChange[];
}

const COMPARED: (keyof RegisterRow)[] = [
  'name',
  'category',
  'site',
  'area',
  'room',
  'make',
  'model',
  'serial',
  'mac',
  'ip',
  'firmware',
  'assetTag',
  'status',
  'installedOn',
  'warrantyEndsOn',
  'endOfLifeOn',
  'supplier',
];

/** What differs between two lists of rows: devices added and removed, and fields that changed (a moved room, a new serial). */
export function diffRows(before: RegisterRow[], after: RegisterRow[]): RegisterDiff {
  const b = new Map(before.map((r) => [r.id, r]));
  const a = new Map(after.map((r) => [r.id, r]));
  const out: RegisterDiff = { added: [], removed: [], changed: [] };
  for (const r of after) if (!b.has(r.id)) out.added.push({ id: r.id, name: r.name });
  for (const r of before) if (!a.has(r.id)) out.removed.push({ id: r.id, name: r.name });
  for (const r of after) {
    const old = b.get(r.id);
    if (!old) continue;
    const fields = COMPARED.flatMap((f) => {
      const x = (old[f] as string | null) ?? null;
      const y = (r[f] as string | null) ?? null;
      return x === y ? [] : [{ field: f, before: x, after: y }];
    });
    if (fields.length) out.changed.push({ id: r.id, name: r.name, fields });
  }
  return out;
}

const GAP_FIELDS: (keyof RegisterRow)[] = ['serial', 'assetTag', 'make', 'model', 'warrantyEndsOn'];
export const rowComplete = (r: RegisterRow) => GAP_FIELDS.every((f) => !!r[f]);

export interface RegisterPayload {
  orgId: string;
  orgName: string;
  kind: 'register';
  number: number;
  scope: Scope;
  scopeName: string;
  title: string;
  takenAt: string;
  summary: {
    devices: number;
    monitored: number;
    recordedOnly: number;
    complete: number;
    completenessPct: number;
  };
  rows: RegisterRow[];
  /** Changes since the previous issue of the same scope. Null for the first. */
  changesSince: { number: number; takenAt: string; diff: RegisterDiff } | null;
}

type Result<T = { id: string }> = { ok: true; value: T } | { ok: false; message: string };
const bad = (message: string): { ok: false; message: string } => ({ ok: false, message });

async function nextNumber(db: RegisterDb, orgId: string, kind: string): Promise<number> {
  const last = await db.registerIssue.findMany({
    where: { orgId, kind },
    orderBy: { number: 'desc' },
  });
  return (last[0]?.number ?? 0) + 1;
}

/** Freezes and signs the register as it is now. Numbered R1, R2, ... per organisation. */
export async function issueRegister(
  db: RegisterDb,
  input: {
    orgId: string;
    scope?: Scope;
    scopeId?: string | null;
    title?: string;
    userId: string | null;
  },
  signing: SigningKey,
  now = new Date(),
): Promise<Result<{ id: string; number: number }>> {
  const scope = input.scope ?? 'org';
  const org = await db.org.findFirst({ where: { id: input.orgId } });
  if (!org) return bad('No such organisation');
  let scopeName = org.name;
  if (scope === 'site') {
    const s = await db.site.findFirst({ where: { id: input.scopeId ?? '', orgId: input.orgId } });
    if (!s) return bad('No such site');
    scopeName = s.name;
  } else if (scope === 'area') {
    const a = await db.area.findFirst({ where: { id: input.scopeId ?? '', orgId: input.orgId } });
    if (!a) return bad('No such area');
    scopeName = a.name;
  }
  const rows = await buildRegisterRows(db, input.orgId, scope, input.scopeId ?? null);
  const number = await nextNumber(db, input.orgId, 'register');
  const previous = (
    await db.registerIssue.findMany({
      where: {
        orgId: input.orgId,
        kind: 'register',
        scope,
        scopeId: scope === 'org' ? null : (input.scopeId ?? null),
      },
      orderBy: { number: 'desc' },
    })
  )[0];
  const prevRows = previous
    ? ((previous.payload as { payload?: { rows?: RegisterRow[] } })?.payload?.rows ?? [])
    : null;
  const complete = rows.filter(rowComplete).length;
  const payload: RegisterPayload = {
    orgId: input.orgId,
    orgName: org.name,
    kind: 'register',
    number,
    scope,
    scopeName,
    title: input.title?.trim() || `Asset register R${number}: ${scopeName}`,
    takenAt: now.toISOString(),
    summary: {
      devices: rows.length,
      monitored: rows.filter((r) => r.kind === 'active').length,
      recordedOnly: rows.filter((r) => r.kind !== 'active').length,
      complete,
      completenessPct: rows.length ? Math.round((complete / rows.length) * 100) : 100,
    },
    rows,
    changesSince:
      previous && prevRows
        ? {
            number: previous.number,
            takenAt: previous.takenAt.toISOString(),
            diff: diffRows(prevRows, rows),
          }
        : null,
  };
  const doc = signDocument(REGISTER_PURPOSE, payload, signing);
  const row = await db.registerIssue.create({
    data: {
      orgId: input.orgId,
      kind: 'register',
      number,
      scope,
      scopeId: scope === 'org' ? null : (input.scopeId ?? null),
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

/** Checks a stored issue (or any document a person pastes) against the keys Kestrel trusts. */
export function checkDocument(raw: unknown, purpose: string, trusted: PublicKey[]) {
  const r = verifyDocument(raw, purpose, trusted);
  if (!r.ok) return { valid: false as const, reason: r.reason };
  const p = (r.document.payload ?? {}) as {
    orgName?: string;
    number?: number;
    title?: string;
    takenAt?: string;
    kind?: string;
  };
  return {
    valid: true as const,
    org: p.orgName ?? null,
    number: p.number ?? null,
    title: p.title ?? null,
    takenAt: p.takenAt ?? null,
    kind: p.kind ?? null,
  };
}

// ---- Export --------------------------------------------------------------------------------------

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const CSV_HEAD = [
  'Name',
  'Type',
  'Category',
  'Site',
  'Area',
  'Room',
  'Make',
  'Model',
  'Serial',
  'MAC',
  'IP',
  'Firmware',
  'Asset tag',
  'Status',
  'Installed',
  'Warranty ends',
  'End of life',
  'Supplier',
  'Serial source',
  'Mismatch',
];

export function registerCsv(rows: RegisterRow[]): string {
  const lines = rows.map((r) =>
    [
      r.name,
      r.kind === 'active' ? 'Monitored' : 'Recorded',
      r.categoryLabel,
      r.site,
      r.area,
      r.room,
      r.make,
      r.model,
      r.serial,
      r.mac,
      r.ip,
      r.firmware,
      r.assetTag,
      r.status,
      r.installedOn,
      r.warrantyEndsOn,
      r.endOfLifeOn,
      r.supplier,
      r.sources.serial ?? '',
      r.mismatches.join(' '),
    ]
      .map(csvCell)
      .join(','),
  );
  return [CSV_HEAD.join(','), ...lines].join('\r\n');
}

// ---- Schedule ------------------------------------------------------------------------------------

export async function setSchedule(
  db: RegisterDb,
  orgId: string,
  everyDays: number | null,
): Promise<Result<{ everyDays: number | null }>> {
  const row = await db.registerSchedule.findFirst({ where: { orgId } });
  if (everyDays === null) {
    if (row) await db.registerSchedule.delete({ where: { orgId } });
    return { ok: true, value: { everyDays: null } };
  }
  if (!Number.isInteger(everyDays) || everyDays < 7 || everyDays > 366)
    return bad('Choose between 7 and 366 days');
  if (row) await db.registerSchedule.update({ where: { orgId }, data: { everyDays } });
  else await db.registerSchedule.create({ data: { orgId, everyDays } });
  return { ok: true, value: { everyDays } };
}

/** Takes the organisation-wide issue for every organisation whose schedule says one is due. */
export async function runScheduledIssues(
  db: RegisterDb,
  signing: SigningKey,
  now = new Date(),
): Promise<number> {
  const due = (await db.registerSchedule.findMany({})).filter(
    (s) => !s.lastIssuedAt || now.getTime() - s.lastIssuedAt.getTime() >= s.everyDays * 86_400_000,
  );
  let n = 0;
  for (const s of due) {
    const r = await issueRegister(db, { orgId: s.orgId, userId: null }, signing, now);
    if (r.ok) {
      await db.registerSchedule.update({ where: { orgId: s.orgId }, data: { lastIssuedAt: now } });
      n++;
    }
  }
  return n;
}
