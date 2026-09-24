import { describe, expect, it } from 'vitest';
import { RoomModel, STARTER_TEMPLATES } from '@kestrel/model';
import { validateRoomModel } from './validate';

const base = (): RoomModel => structuredClone(STARTER_TEMPLATES[0]!.model);
const codes = (m: RoomModel) => validateRoomModel(m).issues.map((i) => i.code);
const edit = (fn: (m: RoomModel) => void): RoomModel => {
  const m = base();
  fn(m);
  return m;
};
const conn = (id: string, from: [string, string], to: [string, string]) => ({
  id,
  from: { deviceId: from[0], portId: from[1] },
  to: { deviceId: to[0], portId: to[1] },
});

describe('validateRoomModel', () => {
  it('passes the 90% room with no issues', () => {
    const r = validateRoomModel(base());
    expect(r.issues).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('passes every populated starter template with no errors', () => {
    for (const t of STARTER_TEMPLATES.filter((x) => !x.id.endsWith('blank'))) {
      const r = validateRoomModel(t.model);
      expect(
        r.issues.filter((i) => i.severity === 'error'),
        t.id,
      ).toEqual([]);
    }
  });

  it('passes blank templates (warnings only)', () => {
    for (const t of STARTER_TEMPLATES.filter((x) => x.id.endsWith('blank'))) {
      expect(validateRoomModel(t.model).valid, t.id).toBe(true);
    }
  });

  it('flags duplicate ids', () => {
    expect(codes(edit((m) => m.devices.push({ ...m.devices[0]! })))).toContain('duplicate_id');
  });

  it('flags unconnected ports as warnings and unreachable sources as errors', () => {
    const m = edit((m) => {
      m.connections = m.connections.filter((c) => c.id !== 'c2');
    });
    const r = validateRoomModel(m);
    expect(r.issues.some((i) => i.code === 'port_unconnected' && i.severity === 'warning')).toBe(
      true,
    );
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === 'route_impossible')).toBe(true);
  });

  it('flags connections to missing ports and wrong direction', () => {
    const dangling = edit((m) => m.connections.push(conn('x', ['nope', 'out'], ['matrix', 'in1'])));
    expect(codes(dangling)).toContain('connection_dangling');
    const backwards = edit((m) =>
      m.connections.push(conn('x', ['matrix', 'in1'], ['display1', 'in'])),
    );
    expect(codes(backwards)).toContain('connection_direction');
  });

  it('flags video-to-audio connections and multiple sources on one input', () => {
    const wrongSignal = edit((m) => {
      m.devices.find((d) => d.id === 'display1')!.ports[0]!.signal = 'video';
      m.connections.push(conn('x', ['dsp', 'out'], ['display1', 'in']));
    });
    expect(codes(wrongSignal)).toContain('connection_signal');
    const twoSources = edit((m) =>
      m.connections.push(conn('x', ['laptop2', 'out'], ['matrix', 'in1'])),
    );
    expect(codes(twoSources)).toContain('input_multiple_sources');
  });

  it('warns on output fan-out', () => {
    const m = edit((m) => m.connections.push(conn('x', ['laptop1', 'out'], ['matrix', 'in2'])));
    expect(codes(m)).toContain('output_fanout');
  });

  it('requires a driver for controllable devices and checks known drivers', () => {
    const m = edit((m) => {
      delete m.devices.find((d) => d.id === 'display1')!.control;
    });
    expect(codes(m)).toContain('driver_missing');
    const r = validateRoomModel(base(), { knownDrivers: new Set(['crestron-dm-nvx']) });
    expect(r.issues.filter((i) => i.code === 'driver_unknown').map((i) => i.ref)).toEqual([
      { kind: 'device', id: 'dsp' },
    ]);
  });

  it('flags actions that use missing devices or unsupported capabilities', () => {
    const m = edit((m) => {
      m.states[0]!.actions.push(
        { id: 'z1', type: 'power', deviceId: 'nope', on: true, dependsOn: [] },
        { id: 'z2', type: 'power', deviceId: 'speakers', on: true, dependsOn: [] },
        { id: 'z3', type: 'camera_preset', deviceId: 'display1', preset: '1', dependsOn: [] },
      );
    });
    const c = codes(m);
    expect(c).toContain('action_device_missing');
    expect(c.filter((x) => x === 'capability_missing')).toHaveLength(2);
  });

  it('flags impossible routes and non-source routes', () => {
    const impossible = edit((m) =>
      m.states[0]!.actions.push({
        id: 'r',
        type: 'route',
        sourceDeviceId: 'laptop1',
        destinationDeviceId: 'speakers',
        destinationPortId: 'nope',
        dependsOn: [],
      }),
    );
    expect(codes(impossible)).toContain('route_impossible');
    const okAudio = edit((m) =>
      m.states[0]!.actions.push({
        id: 'r',
        type: 'route',
        sourceDeviceId: 'laptop1',
        destinationDeviceId: 'speakers',
        dependsOn: [],
      }),
    );
    expect(codes(okAudio)).not.toContain('route_impossible');
    const notSource = edit((m) =>
      m.states[0]!.actions.push({
        id: 'r',
        type: 'route',
        sourceDeviceId: 'display1',
        destinationDeviceId: 'display2',
        dependsOn: [],
      }),
    );
    expect(codes(notSource)).toContain('route_not_source');
  });

  it('flags action dependency problems and state loops', () => {
    const missingDep = edit((m) => (m.states[1]!.actions[3]!.dependsOn = ['nope']));
    expect(codes(missingDep)).toContain('action_dependency_missing');
    const cycle = edit((m) => {
      m.states[1]!.actions[2]!.dependsOn = ['a4'];
    });
    expect(codes(cycle)).toContain('action_cycle');
    const loop = edit((m) => {
      m.states[0]!.actions.push({ id: 'l', type: 'run_state', stateId: 'on', dependsOn: [] });
      m.states[1]!.actions.push({ id: 'l', type: 'run_state', stateId: 'off', dependsOn: [] });
    });
    expect(codes(loop)).toContain('state_cycle');
  });

  it('checks groups', () => {
    const m = edit((m) => {
      m.groups[0]!.members.push('speakers', 'ghost');
      m.groups[0]!.allowedSources.push('display1');
    });
    const c = codes(m);
    expect(c).toContain('group_member_invalid');
    expect(c).toContain('group_member_missing');
    expect(c).toContain('group_source_invalid');
  });

  it('checks present activities', () => {
    const noSources = edit((m) => (m.activities[0]!.sources = []));
    expect(codes(noSources)).toContain('present_no_sources');
    const notAllowed = edit((m) => (m.groups[0]!.allowedSources = ['laptop1']));
    expect(codes(notAllowed)).toContain('source_not_allowed');
    const noTarget = edit((m) => (m.activities[0]!.targetGroupId = undefined));
    expect(codes(noTarget)).toContain('activity_no_target');
  });

  it('warns when an activity is not offered due to missing capabilities', () => {
    const m = edit((m) =>
      m.activities.push({
        id: 'rec',
        name: 'Record',
        kind: 'record',
        hidden: false,
        requires: ['record'],
        sources: [],
        actions: [],
      }),
    );
    const r = validateRoomModel(m);
    expect(r.valid).toBe(true);
    expect(r.issues.some((i) => i.code === 'activity_unavailable')).toBe(true);
  });

  it('checks triggers', () => {
    const badRun = edit((m) => (m.triggers[0]!.run = { type: 'activity', activityId: 'nope' }));
    expect(codes(badRun)).toContain('activity_missing');
    const badSource = edit(
      (m) => (m.triggers[0]!.run = { type: 'activity', activityId: 'present', sourceId: 'nope' }),
    );
    expect(codes(badSource)).toContain('source_missing');
    const noDetect = edit((m) => (m.connections = m.connections.filter((c) => c.id !== 'c1')));
    expect(codes(noDetect)).toContain('signal_detect_unavailable');
    const cron = edit((m) =>
      m.triggers.push({
        id: 's',
        type: 'schedule',
        name: 'Nightly',
        cron: '0 18',
        timezone: 'UTC',
        enabled: true,
        run: { type: 'state', stateId: 'off' },
      }),
    );
    expect(codes(cron)).toContain('cron_invalid');
    const hooks = edit((m) => {
      for (const id of ['w1', 'w2'])
        m.triggers.push({
          id,
          type: 'webhook',
          name: id,
          hookName: 'panic',
          enabled: true,
          run: { type: 'state', stateId: 'off' },
        });
    });
    expect(codes(hooks)).toContain('webhook_duplicate');
  });
});
