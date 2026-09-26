import { slotsFor, type CustomDrivers } from './bindings';
import type { RoomModel } from './room/room-model';

// Bulk room creation (docs/driver-classes.md, "Bulk creation"): one row per room, one column per
// address the template's devices need. Pure functions, so the browser and the server agree.

export const MAX_BULK_ROWS = 100;
export const NAME_HEADER = 'Room name';
const MAX_NAME = 100;

/** One address a device needs, as a column of the grid. Logins are not columns: they come from a shared login. */
export interface BulkColumn {
  /** `deviceId` and setting key, unique in the grid. */
  id: string;
  deviceId: string;
  deviceName: string;
  key: string;
  label: string;
  required: boolean;
  /** What the spreadsheet header says. Unique in the grid. */
  header: string;
}

/** A device that needs a login the grid cannot hold, so it is chosen from the organisation's shared logins. */
export interface BulkLoginSlot {
  deviceId: string;
  deviceName: string;
  labels: string[];
  required: boolean;
}

export interface BulkRow {
  name: string;
  /** Cell text by column id. A missing cell is empty. */
  values: Record<string, string>;
}

export const columnId = (deviceId: string, key: string) => `${deviceId}::${key}`;

export function bulkColumns(model: RoomModel, custom: CustomDrivers = {}) {
  const columns: BulkColumn[] = [];
  const logins: BulkLoginSlot[] = [];
  for (const d of model.devices) {
    const slots = slotsFor(d, custom);
    for (const s of slots.filter((x) => x.scope === 'binding'))
      columns.push({
        id: columnId(d.id, s.key),
        deviceId: d.id,
        deviceName: d.name,
        key: s.key,
        label: s.label,
        required: s.required,
        header: `${d.name}: ${s.label}`,
      });
    const secrets = slots.filter((x) => x.scope === 'secret');
    if (secrets.length)
      logins.push({
        deviceId: d.id,
        deviceName: d.name,
        labels: secrets.map((s) => s.label),
        required: secrets.some((s) => s.required),
      });
  }
  // Two devices with the same name would give two identical headers.
  const seen = new Map<string, number>();
  for (const c of columns) seen.set(c.header.toLowerCase(), (seen.get(c.header.toLowerCase()) ?? 0) + 1);
  for (const c of columns) if (seen.get(c.header.toLowerCase())! > 1) c.header = `${c.header} [${c.deviceId}]`;
  return { columns, logins };
}

// ---- Spreadsheet text ----------------------------------------------------------------------------

/** Parses pasted spreadsheet text (tab separated) or a CSV file (comma separated, quotes allowed). */
export function parseTable(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const sep = firstLine.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The grid as CSV, header first. With no rows it is the blank sheet to send to whoever holds the IP schedule. */
export function toCsv(columns: BulkColumn[], rows: BulkRow[]): string {
  const lines = [[NAME_HEADER, ...columns.map((c) => c.header)], ...rows.map((r) => [r.name, ...columns.map((c) => r.values[c.id] ?? '')])];
  return lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Reads pasted or imported text into rows. A first row that names the room-name column or any
 * address column is a header and is matched by name (in any order); otherwise the columns are
 * taken as room name then each address column in grid order.
 */
export function readGrid(
  text: string,
  columns: BulkColumn[],
): { rows: BulkRow[]; problems: string[] } {
  const table = parseTable(text);
  if (table.length === 0) return { rows: [], problems: ['Nothing to import'] };
  const problems: string[] = [];
  const head = table[0]!.map(norm);
  const byHeader = new Map(columns.map((c) => [norm(c.header), c]));
  const isHeader = head.includes(norm(NAME_HEADER)) || head.some((h) => byHeader.has(h));

  let nameAt = 0;
  let cellsAt: (BulkColumn | null)[];
  let body = table;
  if (isHeader) {
    body = table.slice(1);
    nameAt = head.indexOf(norm(NAME_HEADER));
    if (nameAt < 0) problems.push(`There is no “${NAME_HEADER}” column`);
    cellsAt = head.map((h, i) => (i === nameAt ? null : (byHeader.get(h) ?? null)));
    const used = new Set(cellsAt.filter((c): c is BulkColumn => !!c).map((c) => c.id));
    for (const c of columns) if (c.required && !used.has(c.id)) problems.push(`There is no “${c.header}” column`);
    head.forEach((h, i) => {
      if (i !== nameAt && h && !byHeader.has(h)) problems.push(`Ignored the column “${table[0]![i]!.trim()}”, which this template does not have`);
    });
  } else {
    cellsAt = [null, ...columns];
    if (table[0]!.length > columns.length + 1) problems.push('There are more columns than this template needs; the extra ones were ignored');
  }
  const rows = body.map((cells): BulkRow => {
    const values: Record<string, string> = {};
    cells.forEach((v, i) => {
      const col = cellsAt[i];
      if (col && v.trim() !== '') values[col.id] = v.trim();
    });
    return { name: (cells[nameAt] ?? '').trim(), values };
  });
  return { rows, problems };
}

// ---- Filling -------------------------------------------------------------------------------------

/** "Room {n}" with a number. A pattern with no {n} gets the number added at the end. `{nn}` pads to two digits. */
export function roomName(pattern: string, n: number): string {
  const p = pattern.trim() || 'Room';
  if (/\{nn?\}/.test(p)) return p.replace(/\{nn\}/g, String(n).padStart(2, '0')).replace(/\{n\}/g, String(n));
  return `${p} ${n}`;
}

/**
 * The address `i` steps after `start`: an IPv4 address counts up its last part, and a name that
 * ends in a number ("proj-01.local" style) counts that number, keeping its padding. Null when
 * there is nothing to count.
 */
export function stepAddress(start: string, step: number, i: number): string | null {
  const s = start.trim();
  const ip = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.)(\d{1,3})$/.exec(s);
  if (ip) {
    const last = Number(ip[2]) + step * i;
    return last >= 0 && last <= 255 ? `${ip[1]}${last}` : null;
  }
  const tail = /^(.*?)(\d+)(\D*)$/.exec(s);
  if (tail) {
    const digits = tail[2]!;
    const next = Number(digits) + step * i;
    if (next < 0) return null;
    return `${tail[1]}${String(next).padStart(digits.length, '0')}${tail[3]}`;
  }
  return null;
}

// ---- Checks --------------------------------------------------------------------------------------

export interface BulkIssue {
  /** Zero-based row. */
  row: number;
  level: 'error' | 'warning';
  message: string;
  columnId?: string;
}

const HOST = /^[A-Za-z0-9]([A-Za-z0-9._:-]*[A-Za-z0-9])?$/;

/** Problems in the grid itself. Errors stop the import; warnings still allow it (the room is left to set up). */
export function checkGrid(rows: BulkRow[], columns: BulkColumn[]): BulkIssue[] {
  const out: BulkIssue[] = [];
  if (rows.length === 0) out.push({ row: 0, level: 'error', message: 'Add at least one room' });
  if (rows.length > MAX_BULK_ROWS)
    out.push({ row: MAX_BULK_ROWS, level: 'error', message: `Up to ${MAX_BULK_ROWS} rooms at a time` });

  const names = new Map<string, number>();
  rows.forEach((r, row) => {
    const name = r.name.trim();
    if (!name) out.push({ row, level: 'error', message: 'This room needs a name' });
    else if (name.length > MAX_NAME) out.push({ row, level: 'error', message: `Names are up to ${MAX_NAME} characters` });
    else {
      const key = name.toLowerCase();
      if (names.has(key)) out.push({ row, level: 'error', message: `Same name as row ${names.get(key)! + 1}` });
      else names.set(key, row);
    }
  });

  for (const c of columns) {
    const seen = new Map<string, number>();
    rows.forEach((r, row) => {
      const v = (r.values[c.id] ?? '').trim();
      if (!v) {
        if (c.required) out.push({ row, level: 'warning', columnId: c.id, message: `${c.header} is empty, so the room will need setup` });
        return;
      }
      if (c.key === 'port') {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 65535)
          out.push({ row, level: 'error', columnId: c.id, message: `${c.header} must be a number from 1 to 65535` });
      } else if (c.key === 'host') {
        if (!HOST.test(v) || v.length > 253)
          out.push({ row, level: 'error', columnId: c.id, message: `${c.header} is not a valid address` });
        else {
          const k = v.toLowerCase();
          if (seen.has(k))
            out.push({ row, level: 'warning', columnId: c.id, message: `${c.header} is the same as row ${seen.get(k)! + 1}` });
          else seen.set(k, row);
        }
      } else if (v.length > 2000) out.push({ row, level: 'error', columnId: c.id, message: `${c.header} is too long` });
    });
  }
  return out.sort((a, b) => a.row - b.row);
}

/** A cell as the value stored in bindings: a port is a number, the rest text. */
export function cellValue(key: string, text: string): string | number {
  const v = text.trim();
  return key === 'port' && /^\d+$/.test(v) ? Number(v) : v;
}
