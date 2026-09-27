import { describe, expect, it } from 'vitest';
import {
  ControlPoint,
  Device,
  PointWatch,
  checkWatch,
  POINT_ROLES,
  POINT_ROLE_INFO,
  RoomModel,
  pointFromLevel,
  pointToLevel,
} from './index';

describe('control points', () => {
  it('scale a level between the range of the device and 0 to 100, both ways', () => {
    const p = { min: -60, max: 0 };
    expect(pointToLevel(p, -30)).toBe(50);
    expect(pointToLevel(p, -100)).toBe(0);
    expect(pointToLevel(p, 10)).toBe(100);
    expect(pointFromLevel(p, 50)).toBe(-30);
    expect(pointFromLevel(p, 100)).toBe(0);
    expect(pointFromLevel({ min: -40, max: 12 }, 33)).toBe(-22.8);
  });

  it('use -40 to 0 when the range is not known, and cannot divide by nothing', () => {
    expect(pointToLevel({}, -20)).toBe(50);
    expect(pointFromLevel({}, 50)).toBe(-20);
    expect(pointToLevel({ min: 5, max: 5 }, 5)).toBe(0);
  });

  it('every role says what kind of point it needs', () => {
    expect(POINT_ROLES.map((r) => POINT_ROLE_INFO[r].type)).toEqual([
      'level',
      'mute',
      'level',
      'mute',
      'mute',
    ]);
  });

  it('parse with an empty address, and refuse a bad id or kind', () => {
    expect(ControlPoint.parse({ id: 'vol', name: ' Volume ', type: 'level' })).toMatchObject({
      name: 'Volume',
      address: {},
    });
    expect(ControlPoint.safeParse({ id: 'a b', name: 'x', type: 'level' }).success).toBe(false);
    expect(ControlPoint.safeParse({ id: 'a', name: 'x', type: 'volume' }).success).toBe(false);
  });

  it('are optional on a device, so old rooms are unchanged', () => {
    const room = RoomModel.parse({
      roomType: 'meeting',
      devices: [{ id: 'd', name: 'D', category: 'audio_matrix' }],
    });
    expect(room.devices[0]!.points).toBeUndefined();
    expect(
      Device.parse({
        id: 'd',
        name: 'D',
        category: 'audio_matrix',
        points: [{ id: 'p', name: 'P', type: 'mute' }],
      }).points,
    ).toHaveLength(1);
  });
});

describe('watching a point', () => {
  const watch = (w: object) => PointWatch.parse(w);

  it('is fine while the value holds what was expected', () => {
    expect(checkWatch('Mic mute', watch({ expect: false }), false)).toEqual({ ok: true });
    expect(checkWatch('Status', watch({ expect: 'OK' }), 'OK')).toEqual({ ok: true });
  });

  it('says in words what is wrong when it does not', () => {
    expect(checkWatch('Mic mute', watch({ expect: false }), true)).toEqual({
      ok: false,
      message: 'Mic mute is on, expected off',
    });
    expect(checkWatch('Status', watch({ expect: 'OK' }), 'Fault 12')).toEqual({
      ok: false,
      message: 'Status is Fault 12, expected OK',
    });
  });

  it('checks a range on numbers, on either side', () => {
    const w = watch({ min: 20, max: 80 });
    expect(checkWatch('Level', w, 50).ok).toBe(true);
    expect(checkWatch('Level', w, 10)).toMatchObject({
      ok: false,
      message: 'Level is 10, below 20',
    });
    expect(checkWatch('Level', w, 95)).toMatchObject({
      ok: false,
      message: 'Level is 95, above 80',
    });
  });

  it('watches nothing when nothing is set, and defaults to a warning', () => {
    const w = watch({});
    expect(w.severity).toBe('warning');
    expect(checkWatch('Level', w, 1000)).toEqual({ ok: true });
  });

  it('is part of a control point, and optional', () => {
    const p = ControlPoint.parse({
      id: 'mute1',
      name: 'Mic mute',
      type: 'mute',
      watch: { expect: false },
    });
    expect(p.watch?.expect).toBe(false);
    expect(ControlPoint.parse({ id: 'm2', name: 'Mute', type: 'mute' }).watch).toBeUndefined();
  });
});
