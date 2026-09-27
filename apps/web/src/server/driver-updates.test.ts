import { describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, type RoomModel } from '@kestrel/model';
import { findDriverUpdates, pinnedVersions, type DriverUpdateDb } from './driver-updates';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const A = '33333333-3333-4333-8333-333333333331';
const B = '33333333-3333-4333-8333-333333333332';
const C = '33333333-3333-4333-8333-333333333333';
const R = (n: number) => `44444444-4444-4444-8444-44444444444${n}`;

const withDriver = (driverVersion?: string): RoomModel => {
  const m = structuredClone(STARTER_TEMPLATES[0]!.model);
  m.devices.find((x) => x.id === 'dsp')!.control = { kind: 'driver', driverId: 'custom:acme-amp', ...(driverVersion ? { driverVersion } : {}) };
  return m;
};
const manifest = (version: number | null) => ({
  manifest: { drivers: version === null ? {} : { 'custom:acme-amp': { spec: { id: 'acme-amp', version } } } },
});

function world(over: { latest?: number; rooms?: Record<string, unknown>[]; models?: Record<string, RoomModel> } = {}) {
  const latest = over.latest ?? 3;
  return {
    customDriver: table([
      { id: 'd1', orgId: ORG, slug: 'acme-amp', name: 'Acme amp', latestVersion: latest },
      { id: 'd2', orgId: 'other', slug: 'acme-amp', name: 'Theirs', latestVersion: 99 },
    ]),
    room:
      table(
        over.rooms ?? [
          { id: A, orgId: ORG, name: 'Boardroom', desiredReleaseId: R(1) },
          { id: B, orgId: ORG, name: 'Annex', desiredReleaseId: R(2) },
          { id: C, orgId: ORG, name: 'Empty', desiredReleaseId: null },
        ],
      ),
    release: table([
      { id: R(1), orgId: ORG, manifest: manifest(1) },
      { id: R(2), orgId: ORG, manifest: manifest(3) },
    ]),
    roomDraft: table(
      [A, B, C].map((roomId) => ({ orgId: ORG, roomId, model: over.models?.[roomId] ?? withDriver() })),
    ),
  } as unknown as DriverUpdateDb;
}

describe('driver updates', () => {
  it('reads the version a release pinned', () => {
    expect(pinnedVersions(manifest(4))).toEqual({ 'custom:acme-amp': 4 });
    expect(pinnedVersions(manifest(null))).toEqual({});
    expect(pinnedVersions(null)).toEqual({});
    expect(pinnedVersions({ manifest: { drivers: { x: { spec: {} } } } })).toEqual({});
  });

  it('lists rooms running an older version than the latest, and only those', async () => {
    const list = await findDriverUpdates(world(), ORG);
    expect(list).toEqual([{ roomId: A, roomName: 'Boardroom', driver: { slug: 'acme-amp', name: 'Acme amp' }, running: 1, latest: 3 }]);
  });

  it('lists nothing when every room is on the latest, or the organisation has no drivers', async () => {
    expect(await findDriverUpdates(world({ latest: 1 }), ORG)).toEqual([]);
    const db = world();
    (db.customDriver as unknown as { rows: unknown[] }).rows.length = 0;
    expect(await findDriverUpdates(db, ORG)).toEqual([]);
  });

  it('leaves alone a device whose design names a driver version on purpose', async () => {
    const list = await findDriverUpdates(world({ models: { [A]: withDriver('1') } }), ORG);
    expect(list).toEqual([]);
  });

  it('ignores another organisation’s drivers and rooms with no release', async () => {
    const list = await findDriverUpdates(world(), ORG);
    expect(list.map((u) => u.roomName)).toEqual(['Boardroom']);
    expect(JSON.stringify(list)).not.toContain('Theirs');
  });

  it('limits to the rooms in scope', async () => {
    expect(await findDriverUpdates(world(), ORG, { id: B })).toEqual([]);
    expect((await findDriverUpdates(world(), ORG, { id: A })).map((u) => u.roomId)).toEqual([A]);
  });
});
