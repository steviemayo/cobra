import { describe, expect, it } from 'vitest';
import { checkCopies, requiredFields, type CopyContext, type SourceDevice } from './room-copies';

const ctx = (over: Partial<CopyContext> = {}): CopyContext => ({
  roomNames: new Set(['boardroom 1']),
  addresses: new Map(),
  credentialSets: new Set(['set-1']),
  areas: new Set(['area-1']),
  gateways: new Set(['gw-1']),
  maxRooms: null,
  monitoredRooms: 0,
  ...over,
});

const qsys: SourceDevice = {
  id: 'd-dsp',
  name: 'DSP',
  kind: 'active',
  category: 'audio_matrix',
  control: { kind: 'driver', driverId: 'qsys-core' },
  settings: {},
  credentialSetId: null,
  profileId: null,
  configParams: [],
  points: [
    { id: 'vol', name: 'Room1 volume', type: 'level', address: { component: 'Room1', control: 'gain' } },
  ],
  make: null,
  model: null,
};
const laptop: SourceDevice = { ...qsys, id: 'd-lap', name: 'Laptop', kind: 'passive', control: null, points: [] };
const source = [qsys, laptop];

const copy = (name: string, host = '10.0.0.5', extra: object = {}) => ({
  name,
  devices: [
    { sourceDeviceId: 'd-dsp', values: (host ? { host } : {}) as Record<string, string>, ...extra },
    { sourceDeviceId: 'd-lap' },
  ],
});

describe('requiredFields', () => {
  it('asks a built-in driver for its own address and login fields', () => {
    expect(requiredFields({ kind: 'driver', driverId: 'qsys-core' }).binding).toContain('host');
  });
  it('asks an unknown driver for an address', () => {
    expect(requiredFields({ kind: 'driver', driverId: 'custom:x' })).toEqual({ binding: ['host'], secret: [] });
  });
});

describe('checkCopies', () => {
  it('passes rooms that have a name and an address for every monitored device', () => {
    const r = checkCopies(source, [copy('Room 2'), copy('Room 3', '10.0.0.6')], ctx());
    expect(r.rows.map((x) => x.problems)).toEqual([[], []]);
    expect(r.batch).toEqual([]);
  });

  it('names what is missing', () => {
    const r = checkCopies(source, [copy('Room 2', '')], ctx());
    expect(r.rows[0]!.problems).toEqual(['“DSP” needs its address']);
  });

  it('refuses repeated and existing room names', () => {
    const r = checkCopies(source, [copy('Room 2'), copy('room 2', '10.0.0.6'), copy('Boardroom 1', '10.0.0.7')], ctx());
    expect(r.rows[1]!.problems).toContain('Two new rooms have this name');
    expect(r.rows[2]!.problems).toContain('A room with this name is already in the site');
  });

  it('refuses the same address twice in one batch, and only warns about one already in the estate', () => {
    const existing = new Map([['qsys-core|10.0.0.9|', '“Old DSP”']]);
    const r = checkCopies(source, [copy('Room 2'), copy('Room 3'), copy('Room 4', '10.0.0.9')], ctx({ addresses: existing }));
    expect(r.rows[1]!.problems[0]).toContain('same address as “DSP” in “Room 2”');
    expect(r.rows[2]!.problems).toEqual([]);
    expect(r.rows[2]!.warnings[0]).toContain('existing device');
  });

  it('checks the room’s own control points', () => {
    const bad = copy('Room 2', '10.0.0.5', { points: [{ id: 'v', name: 'Vol', type: 'level', address: { component: 'Room2' } }] });
    const r = checkCopies(source, [bad], ctx());
    expect(r.rows[0]!.problems[0]).toContain('“DSP”');
  });

  it('refuses a saved login that is not there, and areas or gateways from elsewhere', () => {
    const r = checkCopies(source, [{ ...copy('Room 2', '10.0.0.5', { credentialSetId: 'nope' }), areaId: 'x', gatewayId: 'y' }], ctx());
    expect(r.rows[0]!.problems).toEqual(
      expect.arrayContaining(['“DSP”: that saved login does not exist', 'That area is not in this site', 'That gateway is not in this site']),
    );
  });

  it('stops when the plan cannot monitor that many rooms', () => {
    const r = checkCopies(source, [copy('Room 2'), copy('Room 3', '10.0.0.6')], ctx({ maxRooms: 5, monitoredRooms: 4 }));
    expect(r.batch[0]).toContain('2 more will not fit');
  });

  it('does not count a room with nothing monitored', () => {
    const r = checkCopies(source, [{ name: 'Room 2', devices: [{ sourceDeviceId: 'd-dsp', skip: true }] }], ctx({ maxRooms: 1, monitoredRooms: 1 }));
    expect(r.batch).toEqual([]);
  });
});

// ---- Writing ------------------------------------------------------------------------------------

import { beforeAll } from 'vitest';
import { generateSealKey } from '@kestrel/crypto';
import { rewritePoints } from '@kestrel/model';
import { writeCopies, type CopyDb } from './room-copies';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const SRC = '33333333-3333-4333-8333-333333333331';

beforeAll(() => {
  process.env.KESTREL_SECRETS_KEY = generateSealKey();
});

function world() {
  const room = table([{ id: SRC, orgId: ORG, siteId: SITE, name: 'Room 1' }]);
  const device = table([]);
  const db = {
    room,
    device,
    deviceEvent: table([]),
    site: table([{ id: SITE, orgId: ORG }]),
    gateway: table([]),
    credentialSet: table([]),
    area: table([]),
  } as unknown as CopyDb;
  return { db, room, device };
}

describe('writeCopies', () => {
  it('makes each room with its own devices, addresses and rewritten points, and copies no login', async () => {
    const w = world();
    const src = { ...qsys, credentialSetId: null };
    const copies = [2, 3].map((n) => ({
      name: `Room ${n}`,
      devices: [
        {
          sourceDeviceId: 'd-dsp',
          values: { host: `10.0.0.${n}` },
          points: rewritePoints(
            qsys.points as never,
            { find: 'Room1', replace: 'Room{n}' },
            n,
          ),
        },
        { sourceDeviceId: 'd-lap' },
      ],
    }));
    const made = await writeCopies(w.db, {
      orgId: ORG,
      actorId: 'u1',
      source: { id: SRC, siteId: SITE, gatewayId: null, monitorOnly: false },
      sourceDevices: [src, laptop],
      copies,
    });
    expect(made.map((m) => [m.name, m.devices])).toEqual([['Room 2', 2], ['Room 3', 2]]);
    expect(w.room.rows).toHaveLength(3);
    const dsps = w.device.rows.filter((d) => d.name === 'DSP');
    expect(dsps).toHaveLength(2);
    expect(dsps.map((d) => (d.values as { host: string }).host)).toEqual(['10.0.0.2', '10.0.0.3']);
    expect((dsps[1]!.points as { address: { component: string } }[])[0]!.address.component).toBe('Room3');
    expect(dsps.every((d) => d.sealed === null)).toBe(true);
    expect(w.device.rows.find((d) => d.name === 'Laptop')).toMatchObject({ kind: 'passive', control: undefined });
  });

  it('leaves out devices that are skipped', async () => {
    const w = world();
    const made = await writeCopies(w.db, {
      orgId: ORG,
      actorId: 'u1',
      source: { id: SRC, siteId: SITE, gatewayId: null, monitorOnly: false },
      sourceDevices: [qsys, laptop],
      copies: [{ name: 'Room 2', devices: [{ sourceDeviceId: 'd-dsp', skip: true }, { sourceDeviceId: 'd-lap' }] }],
    });
    expect(made[0]!.devices).toBe(1);
    expect(w.device.rows.map((d) => d.name)).toEqual(['Laptop']);
  });
});
