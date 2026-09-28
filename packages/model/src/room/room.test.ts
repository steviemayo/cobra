import { describe, expect, it } from 'vitest';
import {
  Action,
  DEVICE_CATALOG,
  DeviceCategory,
  ROOM_TYPES,
  RoomModel,
  STARTER_TEMPLATES,
  Trigger,
  newRoomModel,
} from '../index';

describe('catalog', () => {
  it('covers every category with a label and capabilities, except pure monitoring infrastructure', () => {
    // A control processor or touch panel gives the room nothing to route or trigger on: it is
    // watched, not a source, sink or control surface, so it has no capability to declare.
    const noCapability: DeviceCategory[] = ['control_processor', 'touch_panel'];
    for (const category of DeviceCategory.options) {
      const info = DEVICE_CATALOG[category];
      expect(info.label).not.toBe('');
      if (noCapability.includes(category)) expect(info.capabilities).toEqual([]);
      else expect(info.capabilities.length).toBeGreaterThan(0);
    }
  });

  it('default ports have unique ids per category', () => {
    for (const info of Object.values(DEVICE_CATALOG)) {
      const ids = info.defaultPorts.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe('RoomModel', () => {
  it('applies defaults to a minimal model', () => {
    const m = RoomModel.parse({ roomType: 'meeting' });
    expect(m.schemaVersion).toBe(1);
    expect(m.settings.defaultVolume).toBe(50);
    expect(m.settings.autoOff).toEqual({ enabled: true, warnSeconds: 30, idleSeconds: 600 });
    expect(m.settings.sourceConflictSeconds).toBe(10);
    expect(m.devices).toEqual([]);
  });

  it('rejects unknown room types and bad ids', () => {
    expect(RoomModel.safeParse({ roomType: 'lobby' }).success).toBe(false);
    expect(
      RoomModel.safeParse({
        roomType: 'meeting',
        devices: [{ id: 'has space', name: 'x', category: 'video_source' }],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown device categories', () => {
    expect(
      RoomModel.safeParse({
        roomType: 'meeting',
        devices: [{ id: 'd', name: 'x', category: 'toaster' }],
      }).success,
    ).toBe(false);
  });

  it('round-trips through JSON', () => {
    const m = STARTER_TEMPLATES[0]!.model;
    expect(RoomModel.parse(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });

  it('newRoomModel uses the room type settings', () => {
    for (const type of ['meeting', 'training'] as const) {
      expect(newRoomModel(type).settings).toEqual(ROOM_TYPES[type].settings);
    }
  });
});

describe('Action', () => {
  it('parses each variant and defaults dependsOn', () => {
    const a = Action.parse({ id: 'a', type: 'power', deviceId: 'd', on: true });
    expect(a.dependsOn).toEqual([]);
    expect(Action.safeParse({ id: 'a', type: 'volume', deviceId: 'd', level: 101 }).success).toBe(
      false,
    );
    expect(Action.safeParse({ id: 'a', type: 'nope' }).success).toBe(false);
  });
});

describe('Trigger', () => {
  it('parses all v1 trigger types', () => {
    const run = { type: 'state', stateId: 'off' };
    const cases = [
      { type: 'tap' },
      { type: 'signal_detect', deviceId: 'd' },
      { type: 'schedule', cron: '0 18 * * 1-5' },
      { type: 'occupancy', deviceId: 'd', occupied: false },
      { type: 'calendar', provider: 'graph', resourceId: 'room@example.com' },
      { type: 'webhook', hookName: 'panic' },
    ];
    for (const [i, c] of cases.entries()) {
      expect(Trigger.safeParse({ id: `t${i}`, name: 'x', run, ...c }).success, c.type).toBe(true);
    }
  });
});

describe('starter templates', () => {
  it('all parse as valid room models', () => {
    for (const t of STARTER_TEMPLATES) {
      expect(RoomModel.safeParse(t.model).success, t.id).toBe(true);
      expect(t.model.roomType).toBe(t.roomType);
    }
  });

  it('template ids are unique', () => {
    const ids = STARTER_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
