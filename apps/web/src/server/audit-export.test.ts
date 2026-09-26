import { describe, expect, it } from 'vitest';
import { MAX_EXPORT_ROWS, csvCell, exportAuditLog, type AuditExportDb } from './audit-export';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '11111111-1111-4111-8111-111111111112';
const U1 = '22222222-2222-4222-8222-222222222221';
const NOW = new Date('2026-09-26T03:00:00Z');
const at = (iso: string) => new Date(iso);

function world(extra: Record<string, unknown>[] = []) {
  const auditLog = table([
    {
      id: 'a1',
      orgId: ORG,
      actorId: U1,
      action: 'room.create',
      target: 'r1',
      meta: { name: 'Boardroom, level 2' },
      createdAt: at('2026-01-02T00:00:00Z'),
    },
    {
      id: 'a2',
      orgId: ORG,
      actorId: null,
      action: 'gateway.enroll',
      target: null,
      meta: { name: '=cmd|calc' },
      createdAt: at('2026-02-01T00:00:00Z'),
    },
    {
      id: 'a3',
      orgId: ORG,
      actorId: 'gone',
      action: 'room.delete',
      target: null,
      meta: { name: 'Say "hi"\nnow' },
      createdAt: at('2026-03-01T00:00:00Z'),
    },
    {
      id: 'x1',
      orgId: OTHER,
      actorId: null,
      action: 'room.create',
      target: null,
      meta: { name: 'Not yours' },
      createdAt: at('2026-01-05T00:00:00Z'),
    },
    ...extra,
  ]);
  const member = table([{ orgId: ORG, userId: U1, email: 'sam@example.com' }]);
  const db = {
    auditLog,
    member,
    staffUser: table([]),
    mspGrant: table([]),
    org: table([]),
  } as unknown as AuditExportDb;
  return { db, auditLog };
}

describe('csv cells', () => {
  it('quote commas, quotes and line breaks, and defuse spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell(null)).toBe('');
    expect(csvCell(12)).toBe('12');
  });
});

describe('exporting the activity log', () => {
  it('writes a CSV of this organisation only, oldest first, with who and what in words', async () => {
    const w = world();
    const file = await exportAuditLog(w.db, ORG, { format: 'csv', now: NOW });
    expect(file.filename).toBe('activity-log-11111111-2026-09-26.csv');
    expect(file.contentType).toBe('text/csv');
    expect(file.count).toBe(3);
    expect(file.truncated).toBe(false);
    const lines = file.body.split('\r\n');
    expect(lines[0]).toBe('Time (UTC),Who,Action,What happened,Target,Details');
    expect(lines[1]).toContain('2026-01-02T00:00:00.000Z,sam@example.com,room.create');
    expect(file.body).not.toContain('Not yours');
    expect(file.body.indexOf('room.create')).toBeLessThan(file.body.indexOf('gateway.enroll'));
  });

  it('shows people who left as a former member and system events as System', async () => {
    const file = await exportAuditLog(world().db, ORG, { format: 'csv', now: NOW });
    expect(file.body).toContain('Former member');
    expect(file.body).toContain('System');
  });

  it('keeps awkward text intact and defuses formulas', async () => {
    const file = await exportAuditLog(world().db, ORG, { format: 'csv', now: NOW });
    // The details column is JSON, so it is quoted whole; a formula in a name never starts a cell.
    expect(file.body).toContain('"{""name"":""Boardroom, level 2""}"');
    expect(file.body).not.toMatch(/(^|,)=cmd/m);
    expect(file.body).toContain('"{""name"":""Say \\""hi\\""\\nnow""}"');
  });

  it('writes JSON with the details as data', async () => {
    const file = await exportAuditLog(world().db, ORG, { format: 'json', now: NOW });
    expect(file.contentType).toBe('application/json');
    const parsed = JSON.parse(file.body) as {
      organisation: string;
      truncated: boolean;
      from: string | null;
      rows: { who: string; action: string; details: { name: string } }[];
    };
    expect(parsed).toMatchObject({ organisation: ORG, truncated: false, from: null });
    expect(parsed.rows.map((r) => r.action)).toEqual([
      'room.create',
      'gateway.enroll',
      'room.delete',
    ]);
    expect(parsed.rows[0]).toMatchObject({
      who: 'sam@example.com',
      details: { name: 'Boardroom, level 2' },
    });
  });

  it('limits to a date range', async () => {
    const file = await exportAuditLog(world().db, ORG, {
      format: 'json',
      from: at('2026-01-15T00:00:00Z'),
      to: at('2026-02-15T00:00:00Z'),
      now: NOW,
    });
    expect((JSON.parse(file.body) as { rows: unknown[] }).rows).toHaveLength(1);
    expect(file.count).toBe(1);
  });

  it('cuts off a huge log and says so', async () => {
    const many = Array.from({ length: MAX_EXPORT_ROWS }, (_, i) => ({
      id: `m${i}`,
      orgId: ORG,
      actorId: null,
      action: 'room.update',
      target: null,
      meta: {},
      createdAt: at('2026-04-01T00:00:00Z'),
    }));
    const file = await exportAuditLog(world(many).db, ORG, { format: 'csv', now: NOW });
    expect(file.count).toBe(MAX_EXPORT_ROWS);
    expect(file.truncated).toBe(true);
  });

  it('an organisation with no activity gets just the header', async () => {
    const file = await exportAuditLog(world().db, '11111111-1111-4111-8111-111111111199', {
      format: 'csv',
      now: NOW,
    });
    expect(file.count).toBe(0);
    expect(file.body).toBe('Time (UTC),Who,Action,What happened,Target,Details\r\n');
  });
});
