import { describe, expect, it } from 'vitest';
import { RoomModel, STARTER_TEMPLATES, newRoomModel } from '@kestrel/model';
import { validateRoomModel } from '@kestrel/engine';
import {
  addConnection,
  addDevice,
  addPort,
  generateDefaultActivities,
  generateDefaultStates,
  newAction,
  newTrigger,
  TRIGGER_TYPES,
  nextActionId,
  removeConnection,
  removeDevice,
  removePort,
  slug,
  uniqueId,
} from './ops';

const starter = () => structuredClone(STARTER_TEMPLATES[0]!.model);

describe('ids', () => {
  it('slugs and de-duplicates', () => {
    expect(slug('  Laptop #1! ')).toBe('laptop-1');
    expect(uniqueId('Laptop 1', ['laptop-1'])).toBe('laptop-1-2');
    expect(uniqueId('', [])).toBe('item');
  });

  it('nextActionId continues after the highest number', () => {
    expect(nextActionId([])).toBe('a1');
    expect(nextActionId([{ id: 'a1' }, { id: 'a4' }] as never)).toBe('a5');
  });
});

describe('devices and ports', () => {
  it('adds a device with catalog ports and a unique id', () => {
    const m = newRoomModel('meeting');
    const a = addDevice(m, 'video_destination');
    const b = addDevice(m, 'video_destination');
    expect(a.id).not.toBe(b.id);
    expect(a.ports).toHaveLength(1);
    expect(RoomModel.safeParse(m).success).toBe(true);
  });

  it('removing a device cleans up connections, groups, sources and triggers', () => {
    const m = starter();
    removeDevice(m, 'laptop1');
    expect(m.devices.some((d) => d.id === 'laptop1')).toBe(false);
    expect(m.connections.some((c) => c.from.deviceId === 'laptop1')).toBe(false);
    expect(m.groups[0]!.allowedSources).toEqual(['laptop2']);
    expect(m.activities[0]!.sources.map((s) => s.id)).toEqual(['laptop2']);
    expect(m.triggers.map((t) => t.id)).toEqual(['t2']);
  });

  it('removing a port drops its connections', () => {
    const m = starter();
    removePort(m, 'matrix', 'in1');
    expect(m.connections.some((c) => c.id === 'c1')).toBe(false);
    expect(m.devices.find((d) => d.id === 'matrix')!.ports.some((p) => p.id === 'in1')).toBe(false);
  });

  it('adds matrix ports with unique ids', () => {
    const m = starter();
    addPort(m, 'matrix', { name: '', direction: 'in', signal: 'av' });
    const ids = m.devices.find((d) => d.id === 'matrix')!.ports.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(RoomModel.safeParse(m).success).toBe(true);
  });
});

describe('connections', () => {
  it('rejects wrong direction, self, occupied inputs and unknown ports', () => {
    const m = starter();
    expect(
      addConnection(
        m,
        { deviceId: 'matrix', portId: 'in1' },
        { deviceId: 'display1', portId: 'in' },
      ).ok,
    ).toBe(false);
    expect(
      addConnection(
        m,
        { deviceId: 'laptop1', portId: 'out' },
        { deviceId: 'matrix', portId: 'in1' },
      ).ok,
    ).toBe(false);
    expect(
      addConnection(
        m,
        { deviceId: 'laptop1', portId: 'nope' },
        { deviceId: 'matrix', portId: 'in2' },
      ).ok,
    ).toBe(false);
  });

  it('adds and removes a valid connection', () => {
    const m = starter();
    removeConnection(m, 'c2');
    const r = addConnection(
      m,
      { deviceId: 'laptop2', portId: 'out' },
      { deviceId: 'matrix', portId: 'in2' },
    );
    expect(r.ok).toBe(true);
    expect(validateRoomModel(m).valid).toBe(true);
  });
});

describe('actions', () => {
  it('builds valid defaults for every type the starter room supports', () => {
    const m = starter();
    for (const type of [
      'power',
      'route',
      'preset',
      'mute',
      'volume',
      'device_command',
      'run_state',
    ] as const) {
      const a = newAction(m, type, []);
      expect(a, type).not.toBeNull();
      m.states[0]!.actions = [a!];
      expect(RoomModel.safeParse(m).success, type).toBe(true);
    }
  });

  it('returns null when nothing can be targeted', () => {
    expect(newAction(newRoomModel('meeting'), 'power', [])).toBeNull();
    expect(newAction(starter(), 'camera_preset', [])).toBeNull();
  });
});

describe('generators', () => {
  it('generates Off/On states and default activities that validate', () => {
    const m = newRoomModel('meeting');
    for (const cat of ['video_source', 'video_destination'] as const) addDevice(m, cat);
    expect(generateDefaultStates(m)).toBe(2);
    expect(generateDefaultStates(m)).toBe(0);
    expect(generateDefaultActivities(m)).toBeGreaterThan(0);
    expect(generateDefaultActivities(m)).toBe(0);
    expect(m.states.find((s) => s.kind === 'off')!.actions).toHaveLength(1);
    expect(m.activities.map((a) => a.kind)).toEqual(['present', 'video_call', 'room_off']);
    expect(RoomModel.safeParse(m).success).toBe(true);
  });
});

describe('triggers', () => {
  it('builds a valid trigger of every type in the starter room', () => {
    for (const { type } of TRIGGER_TYPES) {
      const m = starter();
      const t = newTrigger(m, type);
      expect(t, type).not.toBeNull();
      m.triggers.push(t!);
      expect(RoomModel.safeParse(m).success, type).toBe(true);
    }
  });

  it('returns null when there is nothing to run', () => {
    expect(newTrigger(newRoomModel('meeting'), 'tap')).toBeNull();
  });
});
