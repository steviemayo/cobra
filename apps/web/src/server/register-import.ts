import type { PrismaClient } from '@kestrel/db';
import {
  ASSET_ONLY_CATEGORIES,
  AssetCategory,
  DEVICE_CATALOG,
  DeviceCategory,
  assetCategoryLabel,
} from '@kestrel/model';
import { createDevice, updateDevice, type DeviceInput, type DevicesDb } from './devices';

// Importing an existing asset spreadsheet into the register (docs/pivot-monitoring.md). Rows match
// an existing device by asset tag, then serial, then name in the same room; matched devices get the
// cells that are filled in (as manual values), the rest are created as recorded-only assets. A
// blank cell never clears anything. Everything goes through the same create and update paths as the
// portal, so provenance and history are recorded.
export type ImportDb = DevicesDb & Pick<PrismaClient, 'device' | 'room' | 'site'>;

export const MAX_IMPORT_ROWS = 2000;

/** A small CSV reader: quoted cells, doubled quotes, commas and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const ALIASES: Record<string, string> = {
  name: 'name',
  device: 'name',
  'device name': 'name',
  asset: 'name',
  category: 'category',
  type: 'category',
  'device type': 'category',
  room: 'room',
  location: 'room',
  make: 'make',
  manufacturer: 'make',
  brand: 'make',
  model: 'model',
  serial: 'serial',
  'serial number': 'serial',
  'serial no': 'serial',
  sn: 'serial',
  mac: 'mac',
  'mac address': 'mac',
  ip: 'ip',
  'ip address': 'ip',
  firmware: 'firmware',
  'firmware version': 'firmware',
  'asset tag': 'assetTag',
  tag: 'assetTag',
  'asset id': 'assetTag',
  'asset number': 'assetTag',
  status: 'status',
  installed: 'installedOn',
  'install date': 'installedOn',
  'installed on': 'installedOn',
  'warranty ends': 'warrantyEndsOn',
  warranty: 'warrantyEndsOn',
  'warranty end': 'warrantyEndsOn',
  'warranty expiry': 'warrantyEndsOn',
  'end of life': 'endOfLifeOn',
  eol: 'endOfLifeOn',
  supplier: 'supplier',
  vendor: 'supplier',
  notes: 'notes',
};

const CATEGORY_BY_LABEL = new Map<string, string>([
  ...DeviceCategory.options.map(
    (c) => [DEVICE_CATALOG[c].label.toLowerCase(), c] as [string, string],
  ),
  ...DeviceCategory.options.map((c) => [c, c] as [string, string]),
  ...ASSET_ONLY_CATEGORIES.map((c) => [assetCategoryLabel(c).toLowerCase(), c] as [string, string]),
  ...ASSET_ONLY_CATEGORIES.map((c) => [c, c] as [string, string]),
]);
const STATUS_BY_LABEL: Record<string, string> = {
  'in service': 'in_service',
  in_service: 'in_service',
  spare: 'spare',
  'in repair': 'in_repair',
  in_repair: 'in_repair',
  retired: 'retired',
};

/** DD/MM/YYYY or YYYY-MM-DD to a date, or null. */
export function parseDate(v: string): Date | null {
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number];
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)))
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number];
  else return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

export interface ImportLine {
  line: number;
  name: string;
  action: 'create' | 'update' | 'skip';
  matchedBy?: 'asset tag' | 'serial' | 'name';
  changes: string[];
  warnings: string[];
}
export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
  lines: ImportLine[];
}

/** Reads the header row into field names, refusing a file with no name column. */
export function readTable(rows: string[][]): {
  fields: (string | null)[];
  body: string[][];
  error?: string;
} {
  const head = rows[0];
  if (!head) return { fields: [], body: [], error: 'The file is empty' };
  const fields = head.map((h) => ALIASES[h.trim().toLowerCase()] ?? null);
  if (!fields.includes('name')) return { fields, body: [], error: 'There must be a Name column' };
  return { fields, body: rows.slice(1) };
}

export async function importRegister(
  db: ImportDb,
  input: { orgId: string; siteId: string; csv: string; dryRun: boolean; userId: string | null },
): Promise<ImportResult> {
  const out: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [], lines: [] };
  const site = await db.site.findFirst({ where: { id: input.siteId, orgId: input.orgId } });
  if (!site) return { ...out, errors: ['No such site'] };
  const table = readTable(parseCsv(input.csv));
  if (table.error) return { ...out, errors: [table.error] };
  if (table.body.length > MAX_IMPORT_ROWS)
    return { ...out, errors: [`Import at most ${MAX_IMPORT_ROWS} rows at a time`] };
  const rooms = (await db.room.findMany({
    where: { orgId: input.orgId, siteId: input.siteId },
  })) as { id: string; name: string }[];
  const roomByName = new Map(rooms.map((r) => [r.name.trim().toLowerCase(), r.id]));
  const existing = await db.device.findMany({
    where: { orgId: input.orgId, siteId: input.siteId },
  });

  for (const [i, cells] of table.body.entries()) {
    const line = i + 2;
    const cell = (f: string) => {
      const idx = table.fields.indexOf(f);
      return idx >= 0 ? (cells[idx] ?? '').trim() : '';
    };
    const name = cell('name');
    const entry: ImportLine = { line, name, action: 'skip', changes: [], warnings: [] };
    out.lines.push(entry);
    if (!name) {
      entry.warnings.push('No name');
      out.skipped++;
      continue;
    }
    const patch: DeviceInput = {};
    for (const f of [
      'make',
      'model',
      'serial',
      'mac',
      'ip',
      'firmware',
      'assetTag',
      'supplier',
      'notes',
    ] as const) {
      const v = cell(f);
      if (v) patch[f] = v;
    }
    for (const f of ['installedOn', 'warrantyEndsOn', 'endOfLifeOn'] as const) {
      const v = cell(f);
      if (!v) continue;
      const d = parseDate(v);
      if (d) patch[f] = d;
      else entry.warnings.push(`${f} "${v}" is not a date (use YYYY-MM-DD or DD/MM/YYYY)`);
    }
    const status = cell('status');
    if (status) {
      const s = STATUS_BY_LABEL[status.toLowerCase()];
      if (s) patch.status = s;
      else
        entry.warnings.push(
          `Status "${status}" is not one of in service, spare, in repair, retired`,
        );
    }
    const roomName = cell('room');
    let roomId: string | null | undefined;
    if (roomName) {
      roomId = roomByName.get(roomName.toLowerCase());
      if (!roomId)
        entry.warnings.push(
          `No room called "${roomName}" at ${site.name}, so it is left out of a room`,
        );
    }
    const categoryText = cell('category');
    const category = categoryText ? CATEGORY_BY_LABEL.get(categoryText.toLowerCase()) : undefined;
    if (categoryText && !category)
      entry.warnings.push(`Category "${categoryText}" is not known, so it is recorded as Other`);

    const match =
      (patch.assetTag &&
        existing.find((d) => d.assetTag?.toLowerCase() === patch.assetTag!.toLowerCase()) && {
          d: existing.find((d) => d.assetTag?.toLowerCase() === patch.assetTag!.toLowerCase())!,
          by: 'asset tag' as const,
        }) ||
      (patch.serial &&
        existing.find((d) => d.serial?.toLowerCase() === patch.serial!.toLowerCase()) && {
          d: existing.find((d) => d.serial?.toLowerCase() === patch.serial!.toLowerCase())!,
          by: 'serial' as const,
        }) ||
      (() => {
        const d = existing.find(
          (x) =>
            x.name.toLowerCase() === name.toLowerCase() && (roomId ? x.roomId === roomId : true),
        );
        return d ? { d, by: 'name' as const } : null;
      })();

    if (match) {
      entry.action = 'update';
      entry.matchedBy = match.by;
      for (const [k, v] of Object.entries(patch)) {
        const cur = (match.d as unknown as Record<string, unknown>)[k];
        const same =
          v instanceof Date
            ? cur instanceof Date && cur.toISOString().slice(0, 10) === v.toISOString().slice(0, 10)
            : String(cur ?? '') === String(v);
        if (!same) entry.changes.push(k);
      }
      if (roomId && roomId !== match.d.roomId) {
        patch.roomId = roomId;
        entry.changes.push('room');
      }
      if (entry.changes.length === 0) {
        entry.action = 'skip';
        out.skipped++;
        continue;
      }
      if (!input.dryRun) {
        const r = await updateDevice(db, {
          orgId: input.orgId,
          deviceId: match.d.id,
          actorId: input.userId,
          patch,
        });
        if (!r.ok) {
          out.errors.push(`Line ${line}: ${r.message}`);
          entry.action = 'skip';
          out.skipped++;
          continue;
        }
      }
      out.updated++;
    } else {
      entry.action = 'create';
      entry.changes = Object.keys(patch);
      if (!input.dryRun) {
        const cat = AssetCategory.safeParse(category ?? 'other');
        const r = await createDevice(db, {
          ...patch,
          orgId: input.orgId,
          siteId: input.siteId,
          kind: 'passive',
          name,
          category: cat.success ? cat.data : 'other',
          roomId: roomId ?? null,
          actorId: input.userId,
        });
        if (!r.ok) {
          out.errors.push(`Line ${line}: ${r.message}`);
          entry.action = 'skip';
          out.skipped++;
          continue;
        }
      }
      out.created++;
    }
  }
  return out;
}
