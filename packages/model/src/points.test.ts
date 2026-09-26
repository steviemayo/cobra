import { describe, expect, it } from 'vitest';
import { ControlPoint, Device, POINT_ROLES, POINT_ROLE_INFO, RoomModel, pointFromLevel, pointToLevel } from './index';

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
    expect(POINT_ROLES.map((r) => POINT_ROLE_INFO[r].type)).toEqual(['level', 'mute', 'level', 'mute', 'mute']);
  });

  it('parse with an empty address, and refuse a bad id or kind', () => {
    expect(ControlPoint.parse({ id: 'vol', name: ' Volume ', type: 'level' })).toMatchObject({ name: 'Volume', address: {} });
    expect(ControlPoint.safeParse({ id: 'a b', name: 'x', type: 'level' }).success).toBe(false);
    expect(ControlPoint.safeParse({ id: 'a', name: 'x', type: 'volume' }).success).toBe(false);
  });

  it('are optional on a device, so old rooms are unchanged', () => {
    const room = RoomModel.parse({ roomType: 'meeting', devices: [{ id: 'd', name: 'D', category: 'audio_matrix' }] });
    expect(room.devices[0]!.points).toBeUndefined();
    expect(Device.parse({ id: 'd', name: 'D', category: 'audio_matrix', points: [{ id: 'p', name: 'P', type: 'mute' }] }).points).toHaveLength(1);
  });
});
