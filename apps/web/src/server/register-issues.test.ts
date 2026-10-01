import { beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPair, generateSealKey } from '@kestrel/crypto';
import {
  PM_REPORT_PURPOSE,
  REGISTER_PURPOSE,
  buildRegisterRows,
  checkDocument,
  diffRows,
  issueRegister,
  registerCsv,
  runScheduledIssues,
  setSchedule,
  type RegisterDb,
} from './register-issues';
import { importRegister, parseCsv, parseDate, type ImportDb } from './register-import';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const SITE2 = '22222222-2222-4222-8222-222222222223';
const ROOM = '33333333-3333-4333-8333-333333333331';
const AREA = '55555555-5555-4555-8555-555555555551';
const CHILD = '55555555-5555-4555-8555-555555555552';
const NOW = new Date('2026-09-30T10:00:00Z');
const at = (d: number) => new Date(NOW.getTime() + d * 86_400_000);

beforeAll(() => {
  process.env.KESTREL_SECRETS_KEY = generateSealKey();
});

const keys = generateKeyPair();
const signing = { ...keys, keyId: 'k1' };
const trusted = [{ keyId: 'k1', publicKeyPem: keys.publicKeyPem }];

function world() {
  const org = table([{ id: ORG, name: 'Acme AV' }]);
  const site = table([
    { id: SITE, orgId: ORG, name: 'HQ' },
    { id: SITE2, orgId: ORG, name: 'Annex' },
  ]);
  const area = table([
    { id: AREA, orgId: ORG, siteId: SITE, parentId: null, name: 'Building A' },
    { id: CHILD, orgId: ORG, siteId: SITE, parentId: AREA, name: 'Level 2' },
  ]);
  const room = table([{ id: ROOM, orgId: ORG, siteId: SITE, name: 'Boardroom', areaId: CHILD }]);
  const device = table([
    {
      id: 'd1',
      orgId: ORG,
      siteId: SITE,
      roomId: ROOM,
      name: 'Display',
      kind: 'active',
      category: 'display',
      make: 'Sony',
      model: 'X1',
      serial: 'SN1',
      mac: null,
      ip: '10.0.0.5',
      firmware: '1.0',
      assetTag: 'A-1',
      status: 'in_service',
      installedOn: null,
      warrantyEndsOn: new Date('2028-01-01'),
      endOfLifeOn: null,
      supplier: null,
      provenance: {
        serial: { source: 'discovered', at: 'x' },
        model: { source: 'manual', discovered: 'X2', at: 'x' },
      },
    },
    {
      id: 'd2',
      orgId: ORG,
      siteId: SITE,
      roomId: null,
      name: 'Laptop',
      kind: 'passive',
      category: 'computer',
      make: null,
      model: null,
      serial: null,
      mac: null,
      ip: null,
      firmware: null,
      assetTag: null,
      status: 'spare',
      installedOn: null,
      warrantyEndsOn: null,
      endOfLifeOn: null,
      supplier: null,
      provenance: {},
    },
    {
      id: 'd3',
      orgId: ORG,
      siteId: SITE2,
      roomId: null,
      name: 'Annex camera',
      kind: 'passive',
      category: 'fixed_camera',
      make: 'Axis',
      model: 'P1',
      serial: 'SN3',
      mac: null,
      ip: null,
      firmware: null,
      assetTag: 'A-3',
      status: 'in_service',
      installedOn: null,
      warrantyEndsOn: new Date('2027-01-01'),
      endOfLifeOn: null,
      supplier: null,
      provenance: {},
    },
  ]);
  const registerIssue = table([]);
  const registerSchedule = table([]);
  const deviceEvent = table([]);
  const db = {
    org,
    site,
    area,
    room,
    device,
    registerIssue,
    registerSchedule,
    deviceEvent,
  } as unknown as RegisterDb & ImportDb;
  return { db, device, registerIssue, registerSchedule, room, deviceEvent };
}

describe('the register', () => {
  it('lists every device with its place, and says where each value came from', async () => {
    const w = world();
    const rows = await buildRegisterRows(w.db, ORG);
    expect(rows).toHaveLength(3);
    const d1 = rows.find((r) => r.id === 'd1')!;
    expect(d1).toMatchObject({
      site: 'HQ',
      area: 'Building A / Level 2',
      room: 'Boardroom',
      categoryLabel: expect.any(String),
      warrantyEndsOn: '2028-01-01',
    });
    expect(d1.sources).toEqual({ serial: 'discovered', model: 'manual' });
    expect(d1.mismatches).toEqual(['model']);
  });

  it('limits to a site, or to an area and everything inside it', async () => {
    const w = world();
    expect((await buildRegisterRows(w.db, ORG, 'site', SITE2)).map((r) => r.id)).toEqual(['d3']);
    expect((await buildRegisterRows(w.db, ORG, 'area', AREA)).map((r) => r.id)).toEqual(['d1']);
    expect((await buildRegisterRows(w.db, ORG, 'area', CHILD)).map((r) => r.id)).toEqual(['d1']);
  });

  it('exports every row as CSV with quoting', async () => {
    const w = world();
    w.device.rows[1]!.name = 'Laptop, "spare"';
    const csv = registerCsv(await buildRegisterRows(w.db, ORG));
    expect(csv.split('\r\n')).toHaveLength(4);
    expect(csv).toContain('"Laptop, ""spare"""');
  });
});

describe('register issues', () => {
  it('numbers, freezes and signs each issue, and the signature checks out', async () => {
    const w = world();
    const first = await issueRegister(w.db, { orgId: ORG, userId: null }, signing, NOW);
    if (!first.ok) throw new Error(first.message);
    expect(first.value.number).toBe(1);
    const stored = w.registerIssue.rows[0]!;
    expect(stored).toMatchObject({ kind: 'register', number: 1, scope: 'org' });
    const check = checkDocument(stored.payload, REGISTER_PURPOSE, trusted);
    expect(check).toMatchObject({ valid: true, org: 'Acme AV', number: 1 });
    // Later changes to the register do not touch an issued copy.
    w.device.rows[0]!.serial = 'CHANGED';
    const rows = (stored.payload as { payload: { rows: { serial: string }[] } }).payload.rows;
    expect(rows.find((r) => r.serial === 'CHANGED')).toBeUndefined();
    const second = await issueRegister(w.db, { orgId: ORG, userId: null }, signing, at(30));
    if (!second.ok) throw new Error(second.message);
    expect(second.value.number).toBe(2);
    const changes = (
      w.registerIssue.rows[1]!.payload as {
        payload: {
          changesSince: { number: number; diff: { changed: { fields: { field: string }[] }[] } };
        };
      }
    ).payload.changesSince;
    expect(changes.number).toBe(1);
    expect(changes.diff.changed[0]!.fields.map((f) => f.field)).toContain('serial');
  });

  it('is refused when the content is changed after signing, for another purpose, or by another key', async () => {
    const w = world();
    await issueRegister(w.db, { orgId: ORG, userId: null }, signing, NOW);
    const doc = structuredClone(w.registerIssue.rows[0]!.payload) as {
      payload: { rows: { serial: string }[] };
    };
    doc.payload.rows[0]!.serial = 'FORGED';
    expect(checkDocument(doc, REGISTER_PURPOSE, trusted)).toMatchObject({
      valid: false,
      reason: 'hash_mismatch',
    });
    expect(
      checkDocument(w.registerIssue.rows[0]!.payload, PM_REPORT_PURPOSE, trusted),
    ).toMatchObject({ valid: false, reason: 'wrong_purpose' });
    expect(
      checkDocument(w.registerIssue.rows[0]!.payload, REGISTER_PURPOSE, [
        { keyId: 'k1', publicKeyPem: generateKeyPair().publicKeyPem },
      ]),
    ).toMatchObject({ valid: false, reason: 'bad_signature' });
  });

  it('numbers a site issue against its own earlier issues, and refuses a site from elsewhere', async () => {
    const w = world();
    expect(
      (
        await issueRegister(
          w.db,
          { orgId: ORG, scope: 'site', scopeId: SITE2, userId: null },
          signing,
          NOW,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await issueRegister(
          w.db,
          {
            orgId: ORG,
            scope: 'site',
            scopeId: '99999999-9999-4999-8999-999999999999',
            userId: null,
          },
          signing,
        )
      ).ok,
    ).toBe(false);
    const p = w.registerIssue.rows[0]!.payload as {
      payload: { summary: { devices: number }; scopeName: string; changesSince: unknown };
    };
    expect(p.payload.summary.devices).toBe(1);
    expect(p.payload.scopeName).toBe('Annex');
    expect(p.payload.changesSince).toBeNull();
  });

  it('takes a scheduled issue when one is due, and not before', async () => {
    const w = world();
    expect((await setSchedule(w.db, ORG, 3)).ok).toBe(false);
    expect((await setSchedule(w.db, ORG, 90)).ok).toBe(true);
    expect(await runScheduledIssues(w.db, signing, NOW)).toBe(1);
    expect(await runScheduledIssues(w.db, signing, at(30))).toBe(0);
    expect(await runScheduledIssues(w.db, signing, at(91))).toBe(1);
    expect(w.registerIssue.rows).toHaveLength(2);
    await setSchedule(w.db, ORG, null);
    expect(w.registerSchedule.rows).toHaveLength(0);
  });
});

describe('diffRows', () => {
  it('finds devices added, removed, moved and re-serialled', () => {
    const base = {
      id: 'a',
      name: 'A',
      kind: 'active',
      category: 'display',
      categoryLabel: 'Display',
      site: 'HQ',
      area: '',
      room: 'R1',
      make: null,
      model: null,
      serial: 'S1',
      mac: null,
      ip: null,
      firmware: null,
      assetTag: null,
      status: 'in_service',
      installedOn: null,
      warrantyEndsOn: null,
      endOfLifeOn: null,
      supplier: null,
      sources: {},
      mismatches: [],
    };
    const d = diffRows(
      [base, { ...base, id: 'gone', name: 'Gone' }],
      [
        { ...base, room: 'R2', serial: 'S2' },
        { ...base, id: 'new', name: 'New' },
      ],
    );
    expect(d.added.map((x) => x.id)).toEqual(['new']);
    expect(d.removed.map((x) => x.id)).toEqual(['gone']);
    expect(d.changed[0]!.fields.map((f) => f.field).sort()).toEqual(['room', 'serial']);
  });
});

describe('CSV', () => {
  it('reads quotes, doubled quotes and line breaks in cells, and dates in two formats', () => {
    expect(parseCsv('Name,Notes\r\n"A, B","say ""hi""\nagain"\r\nC,')).toEqual([
      ['Name', 'Notes'],
      ['A, B', 'say "hi"\nagain'],
      ['C', ''],
    ]);
    expect(parseDate('2026-09-30')?.toISOString().slice(0, 10)).toBe('2026-09-30');
    expect(parseDate('30/09/2026')?.toISOString().slice(0, 10)).toBe('2026-09-30');
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('soon')).toBeNull();
  });
});

describe('import', () => {
  const csv = [
    'Name,Type,Room,Make,Model,Serial number,Asset tag,Warranty ends,Status',
    'New projector,Projector,Boardroom,Epson,EB-1,EP-1,,31/12/2028,Spare',
    'Display,,,,,SN1,,,',
    'Ghost,Sofa,Nowhere,,,,,not-a-date,broken',
    ',,,,,,,,',
    'Boardroom laptop,Computer or laptop,Boardroom,Dell,L1,DL-1,A-9,,',
  ].join('\n');

  it('shows what it would do without changing anything', async () => {
    const w = world();
    const r = await importRegister(w.db, {
      orgId: ORG,
      siteId: SITE,
      csv,
      dryRun: true,
      userId: null,
    });
    expect(r).toMatchObject({ created: 3, updated: 0, skipped: 1, errors: [] });
    expect(w.device.rows).toHaveLength(3);
    expect(r.lines.find((l) => l.name === 'Ghost')!.warnings.join(' ')).toMatch(
      /No room|not a date|not one of|not known/,
    );
  });

  it('creates recorded assets, matches existing ones by serial, and never blanks a field', async () => {
    const w = world();
    const r = await importRegister(w.db, {
      orgId: ORG,
      siteId: SITE,
      csv,
      dryRun: false,
      userId: 'u1',
    });
    expect(r.created).toBe(3);
    const proj = w.device.rows.find((d) => d.name === 'New projector')!;
    expect(proj).toMatchObject({
      kind: 'passive',
      category: 'projector',
      make: 'Epson',
      serial: 'EP-1',
      roomId: ROOM,
      status: 'spare',
    });
    expect((proj.provenance as Record<string, { source: string }>).serial?.source).toBe('manual');
    const laptop = w.device.rows.find((d) => d.name === 'Boardroom laptop')!;
    expect(laptop).toMatchObject({ category: 'computer', assetTag: 'A-9' });
    // The Display row matched the existing device by serial and had nothing new to add.
    expect(r.lines.find((l) => l.name === 'Display')).toMatchObject({ action: 'skip' });
    expect(w.device.rows.find((d) => d.id === 'd1')!.make).toBe('Sony');
    // A second run changes nothing.
    const again = await importRegister(w.db, {
      orgId: ORG,
      siteId: SITE,
      csv,
      dryRun: false,
      userId: 'u1',
    });
    expect(again.created).toBe(0);
  });

  it('updates a matched device with the cells that are filled in, and records the history', async () => {
    const w = world();
    const r = await importRegister(w.db, {
      orgId: ORG,
      siteId: SITE,
      csv: 'Name,Asset tag,Supplier,Firmware\nWhatever,A-1,Acme Supply,9.9',
      dryRun: false,
      userId: 'u1',
    });
    expect(r).toMatchObject({ updated: 1, created: 0 });
    expect(r.lines[0]).toMatchObject({ matchedBy: 'asset tag' });
    expect(w.device.rows[0]).toMatchObject({ supplier: 'Acme Supply', firmware: '9.9' });
    expect(w.deviceEvent.rows.map((e) => e.type)).toContain('field_changed');
  });

  it('refuses a file with no name column, an empty file, or a site from elsewhere', async () => {
    const w = world();
    expect(
      (
        await importRegister(w.db, {
          orgId: ORG,
          siteId: SITE,
          csv: 'Serial\nX',
          dryRun: true,
          userId: null,
        })
      ).errors[0],
    ).toMatch(/Name column/);
    expect(
      (
        await importRegister(w.db, {
          orgId: ORG,
          siteId: SITE,
          csv: '',
          dryRun: true,
          userId: null,
        })
      ).errors[0],
    ).toMatch(/empty/);
    expect(
      (
        await importRegister(w.db, {
          orgId: ORG,
          siteId: '99999999-9999-4999-8999-999999999999',
          csv: 'Name\nX',
          dryRun: true,
          userId: null,
        })
      ).errors[0],
    ).toMatch(/No such site/);
  });
});
