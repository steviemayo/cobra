import { describe, expect, it } from 'vitest';
import {
  RoomModel,
  bulkColumns,
  cellValue,
  checkGrid,
  parseTable,
  readGrid,
  roomName,
  stepAddress,
  toCsv,
  type BulkRow,
  type Device,
} from './index';

const device = (over: Partial<Device>): Device => ({
  id: 'd1',
  name: 'Device',
  category: 'display',
  ports: [],
  extraCapabilities: [],
  settings: {},
  ...over,
});
const room = (devices: Device[]) => RoomModel.parse({ roomType: 'meeting', devices });

const proj = device({ id: 'proj', name: 'Projector', category: 'projector', control: { kind: 'generic', protocol: 'pjlink' } });
const dsp = device({ id: 'dsp', name: 'DSP', category: 'audio_matrix', control: { kind: 'driver', driverId: 'qsys-core' } });
const { columns, logins } = bulkColumns(room([proj, dsp]));
const host = columns.find((c) => c.deviceId === 'proj' && c.key === 'host')!;
const dspHost = columns.find((c) => c.deviceId === 'dsp' && c.key === 'host')!;

describe('columns', () => {
  it('has one column per address and none for logins, which are chosen from shared logins', () => {
    expect(columns.map((c) => c.header)).toEqual([
      'Projector: Address',
      'Projector: Port',
      'DSP: Core address',
      'DSP: Logon name (if the Core needs one)',
    ]);
    expect(logins.map((l) => l.deviceId)).toEqual(['proj', 'dsp']);
    expect(logins[0]!.required).toBe(false);
  });

  it('tells apart two devices with the same name', () => {
    const two = bulkColumns(room([proj, { ...proj, id: 'proj2' }])).columns;
    expect(new Set(two.map((c) => c.header)).size).toBe(two.length);
    expect(two[0]!.header).toBe('Projector: Address [proj]');
  });

  it('is empty for a room with nothing to set up', () => {
    expect(bulkColumns(room([device({})])).columns).toEqual([]);
  });
});

describe('spreadsheet text', () => {
  it('reads tab separated text pasted from a spreadsheet', () => {
    expect(parseTable('a\tb\n1\t2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('reads CSV with quotes, doubled quotes, commas in cells, CRLF and a BOM', () => {
    expect(parseTable('﻿a,"b, c","say ""hi"""\r\n1,2,3')).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['1', '2', '3'],
    ]);
  });

  it('skips blank lines and keeps empty cells', () => {
    expect(parseTable('a,,c\n\n,,\nd,e,f')).toEqual([['a', '', 'c'], ['d', 'e', 'f']]);
  });

  it('writes a blank sheet with just the headers, and round-trips rows', () => {
    const blank = toCsv(columns, []);
    expect(blank.split('\r\n')[0]).toBe('Room name,Projector: Address,Projector: Port,DSP: Core address,DSP: Logon name (if the Core needs one)');
    const rows: BulkRow[] = [{ name: 'Room, one', values: { [host.id]: '10.0.0.5' } }];
    const back = readGrid(toCsv(columns, rows), columns);
    expect(back.rows).toEqual(rows);
  });
});

describe('reading a grid', () => {
  it('matches columns by header, in any order, ignoring case', () => {
    const text = `dsp: core address\tROOM NAME\tProjector: Address\nd1\tRoom 1\tp1\n`;
    const { rows, problems } = readGrid(text, columns);
    expect(rows).toEqual([{ name: 'Room 1', values: { [dspHost.id]: 'd1', [host.id]: 'p1' } }]);
    expect(problems).toEqual([]);
  });

  it('says which required column is missing and which column it ignored', () => {
    const { problems } = readGrid('Room name,Projector: Address,Colour\nA,1.1.1.1,red', columns);
    expect(problems).toEqual([
      'There is no “DSP: Core address” column',
      'Ignored the column “Colour”, which this template does not have',
    ]);
  });

  it('without a header, takes room name then the columns in order', () => {
    const { rows } = readGrid('Room 1,10.0.0.1,4352,10.0.0.2\nRoom 2,10.0.0.3', columns);
    expect(rows[0]).toEqual({ name: 'Room 1', values: { [host.id]: '10.0.0.1', [columns[1]!.id]: '4352', [dspHost.id]: '10.0.0.2' } });
    expect(rows[1]!.values).toEqual({ [host.id]: '10.0.0.3' });
  });

  it('reports a header with no room name column', () => {
    expect(readGrid('Projector: Address\n1.1.1.1', columns).problems).toContain('There is no “Room name” column');
  });

  it('has nothing to say about empty text', () => {
    expect(readGrid('  \n', columns)).toEqual({ rows: [], problems: ['Nothing to import'] });
  });
});

describe('filling', () => {
  it('names rooms from a pattern', () => {
    expect(roomName('Room {n}', 3)).toBe('Room 3');
    expect(roomName('L{nn}', 3)).toBe('L03');
    expect(roomName('Training', 2)).toBe('Training 2');
    expect(roomName('  ', 1)).toBe('Room 1');
  });

  it('counts up an IPv4 address and stops at the end of the range', () => {
    expect(stepAddress('10.0.0.5', 1, 0)).toBe('10.0.0.5');
    expect(stepAddress('10.0.0.5', 2, 3)).toBe('10.0.0.11');
    expect(stepAddress('10.0.0.250', 1, 10)).toBeNull();
  });

  it('counts the number at the end of a name, keeping its padding', () => {
    expect(stepAddress('proj-01.local', 1, 1)).toBe('proj-02.local');
    expect(stepAddress('proj-09', 1, 1)).toBe('proj-10');
    expect(stepAddress('proj-099', 1, 1)).toBe('proj-100');
  });

  it('cannot count a name with no number', () => {
    expect(stepAddress('projector', 1, 1)).toBeNull();
  });
});

describe('checking a grid', () => {
  const row = (name: string, values: Record<string, string> = {}): BulkRow => ({ name, values });
  const ok = { [host.id]: '10.0.0.1', [dspHost.id]: '10.0.1.1' };

  it('passes a clean grid', () => {
    expect(checkGrid([row('A', ok), row('B', { [host.id]: '10.0.0.2', [dspHost.id]: '10.0.1.2' })], columns)).toEqual([]);
  });

  it('needs at least one room and no more than 100', () => {
    expect(checkGrid([], columns)[0]).toMatchObject({ level: 'error', message: 'Add at least one room' });
    const many = Array.from({ length: 101 }, (_, i) => row(`R${i}`, ok));
    expect(checkGrid(many, columns).some((i) => i.message.includes('Up to 100'))).toBe(true);
  });

  it('errors on a blank, overlong or repeated name, ignoring case', () => {
    const issues = checkGrid([row(''), row('x'.repeat(101)), row('Room'), row('room')], []);
    expect(issues.map((i) => [i.row, i.level])).toEqual([[0, 'error'], [1, 'error'], [3, 'error']]);
    expect(issues[2]!.message).toBe('Same name as row 3');
  });

  it('warns, not errors, on an empty required address: the room is left to set up', () => {
    const issues = checkGrid([row('A', { [host.id]: '10.0.0.1' })], columns);
    expect(issues).toEqual([expect.objectContaining({ level: 'warning', columnId: dspHost.id })]);
  });

  it('warns when two rooms share an address, but not for a port', () => {
    const portCol = columns.find((c) => c.key === 'port')!;
    const issues = checkGrid(
      [row('A', { ...ok, [portCol.id]: '4352' }), row('B', { ...ok, [portCol.id]: '4352' })],
      columns,
    );
    expect(issues.filter((i) => i.message.includes('same as row 1')).map((i) => i.columnId).sort()).toEqual([dspHost.id, host.id].sort());
  });

  it('errors on a bad port or address', () => {
    const portCol = columns.find((c) => c.key === 'port')!;
    const bad = checkGrid([row('A', { ...ok, [portCol.id]: '70000' }), row('B', { ...ok, [host.id]: 'not an address' })], columns);
    expect(bad.filter((i) => i.level === 'error').map((i) => i.row)).toEqual([0, 1]);
  });

  it('turns a port cell into a number and leaves the rest as text', () => {
    expect(cellValue('port', ' 4352 ')).toBe(4352);
    expect(cellValue('host', ' 10.0.0.1 ')).toBe('10.0.0.1');
  });
});
