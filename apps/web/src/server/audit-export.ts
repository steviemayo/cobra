import type { PrismaClient } from '@kestrel/db';
import { describeAudit } from '../lib/audit-text';
import { viewAuditRows, type AuditViewDb } from './audit-view';

// Downloading an organisation's activity log as CSV or JSON. Functions take the database as a
// parameter so they can be tested without one.
export type AuditExportDb = Pick<PrismaClient, 'auditLog'> & AuditViewDb;

export type ExportFormat = 'csv' | 'json';

/** A download this large is cut off and says so, rather than building an enormous file in memory. */
export const MAX_EXPORT_ROWS = 50_000;

export interface AuditExport {
  filename: string;
  contentType: string;
  body: string;
  count: number;
  /** More rows matched than fit; narrow the dates for the rest. */
  truncated: boolean;
}

/**
 * One CSV cell. Quotes anything with a comma, quote or line break, and defuses text a spreadsheet
 * would run as a formula (starting with =, +, - or @).
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function exportAuditLog(
  db: AuditExportDb,
  orgId: string,
  opts: { format: ExportFormat; from?: Date; to?: Date; now?: Date },
): Promise<AuditExport> {
  const now = opts.now ?? new Date();
  const range: Record<string, Date> = {};
  if (opts.from) range.gte = opts.from;
  if (opts.to) range.lt = opts.to;
  const found = await db.auditLog.findMany({
    where: { orgId, ...(Object.keys(range).length ? { createdAt: range } : {}) },
    orderBy: { createdAt: 'asc' },
    take: MAX_EXPORT_ROWS + 1,
  });
  const truncated = found.length > MAX_EXPORT_ROWS;
  const rows = await viewAuditRows(db, orgId, found.slice(0, MAX_EXPORT_ROWS));
  const stamp = now.toISOString().slice(0, 10);
  const filename = `activity-log-${orgId.slice(0, 8)}-${stamp}.${opts.format}`;

  const lines = rows.map((r) => ({
    time: r.createdAt.toISOString(),
    who: r.actor,
    action: r.action,
    what: describeAudit(r.action, r.meta),
    target: r.target ?? '',
    details: JSON.stringify(r.meta),
  }));

  if (opts.format === 'json')
    return {
      filename,
      contentType: 'application/json',
      count: lines.length,
      truncated,
      body: JSON.stringify(
        {
          organisation: orgId,
          exportedAt: now.toISOString(),
          from: opts.from?.toISOString() ?? null,
          to: opts.to?.toISOString() ?? null,
          truncated,
          rows: lines.map((l) => ({ ...l, details: JSON.parse(l.details) as unknown })),
        },
        null,
        2,
      ),
    };

  const header = ['Time (UTC)', 'Who', 'Action', 'What happened', 'Target', 'Details'];
  const body = [
    header.map(csvCell).join(','),
    ...lines.map((l) =>
      [l.time, l.who, l.action, l.what, l.target, l.details].map(csvCell).join(','),
    ),
  ].join('\r\n');
  return { filename, contentType: 'text/csv', body: body + '\r\n', count: lines.length, truncated };
}
