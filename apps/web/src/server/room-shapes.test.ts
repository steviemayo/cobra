import { describe, expect, it } from 'vitest';
import type { ControlPoint } from '@kestrel/model';
import { saveShape, slotsFromDevices, slotsOf, slotToSource, type ShapeDb } from './room-shapes';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const ROOM = '33333333-3333-4333-8333-333333333331';
const OTHER = '33333333-3333-4333-8333-333333333332';
const SET = '44444444-4444-4444-8444-444444444444';

const point = (id: string, roomId?: string): ControlPoint => ({
  id,
  name: id,
  type: 'level',
  address: { component: id, control: 'gain' },
  ...(roomId ? { roomId } : {}),
});

const dsp = {
  id: 'd-dsp',
  name: 'DSP',
  kind: 'active',
  category: 'audio_matrix',
  control: { kind: 'driver', driverId: 'qsys-core' },
  settings: { design: 'x' },
  values: { host: '10.0.0.5' },
  sealed: 'v1.secret',
  credentialSetId: SET,
  profileId: null,
  configParams: [],
  points: [point('a', ROOM), point('b', OTHER), point('whole')],
  make: 'QSC',
  model: 'Core 110f',
  orgId: ORG,
  roomId: ROOM,
  createdAt: new Date(1),
};

describe('room shapes', () => {
  it('keep the design and no address or login, and only this room’s points', () => {
    const [slot] = slotsFromDevices([dsp], ROOM);
    expect(slot).toMatchObject({ id: 'd-dsp', name: 'DSP', kind: 'active', make: 'QSC', credentialSetId: SET });
    expect(slot!.points.map((p) => p.id)).toEqual(['a', 'whole']);
    expect(slot!.points.every((p) => !('roomId' in p))).toBe(true);
    expect(JSON.stringify(slot)).not.toContain('10.0.0.5');
    expect(JSON.stringify(slot)).not.toContain('secret');
  });

  it('read back as copy sources, and ignore stored slots that no longer parse', () => {
    const slots = slotsOf([...slotsFromDevices([dsp], ROOM), { nonsense: true }]);
    expect(slots).toHaveLength(1);
    expect(slotToSource(slots[0]!)).toMatchObject({ id: 'd-dsp', kind: 'active', category: 'audio_matrix' });
  });

  function world() {
    const room = table([{ id: ROOM, orgId: ORG, name: 'Room 1' }]);
    const device = table([dsp]);
    const roomShape = table([]);
    return { db: { room, device, roomShape } as unknown as ShapeDb, roomShape };
  }

  it('save a room’s devices under a name, once', async () => {
    const w = world();
    const first = await saveShape(w.db, { orgId: ORG, roomId: ROOM, name: ' Standard ', actorId: 'u' });
    expect(first.ok).toBe(true);
    expect(w.roomShape.rows[0]).toMatchObject({ name: 'Standard', orgId: ORG });
    expect(await saveShape(w.db, { orgId: ORG, roomId: ROOM, name: 'Standard', actorId: 'u' })).toMatchObject({ ok: false });
    expect(await saveShape(w.db, { orgId: ORG, roomId: ROOM, name: '  ', actorId: 'u' })).toMatchObject({ ok: false });
    expect(await saveShape(w.db, { orgId: ORG, roomId: 'nope', name: 'X', actorId: 'u' })).toMatchObject({ ok: false });
  });
});
