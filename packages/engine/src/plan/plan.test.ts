import { describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, type RoomModel } from '@kestrel/model';
import { buildGraph, findRoute } from '../validate/graph';
import { planActivity, planStopOverlay } from './plan';

const meeting = (): RoomModel => structuredClone(STARTER_TEMPLATES[0]!.model);
const training = (): RoomModel =>
  structuredClone(STARTER_TEMPLATES.find((t) => t.id === 'training-recorded')!.model);
const activity = (m: RoomModel, id: string) => m.activities.find((a) => a.id === id)!;

describe('findRoute', () => {
  it('returns the hops and connections between a laptop and a display', () => {
    const g = buildGraph(meeting());
    const path = findRoute(g, { deviceId: 'laptop1' }, { deviceId: 'display2' });
    expect(path).toEqual({
      sourcePortId: 'out',
      destinationPortId: 'in',
      hops: [{ deviceId: 'matrix', inPortId: 'in1', outPortId: 'out2' }],
      connectionIds: ['c1', 'c4'],
    });
  });

  it('routes audio through the matrix and the DSP to the speakers', () => {
    const g = buildGraph(meeting());
    const path = findRoute(g, { deviceId: 'laptop2' }, { deviceId: 'speakers' })!;
    expect(path.hops.map((h) => `${h.deviceId}:${h.inPortId}>${h.outPortId}`)).toEqual([
      'matrix:in2>out3',
      'dsp:in>out',
    ]);
  });

  it('returns null when nothing connects them', () => {
    const m = meeting();
    m.connections = m.connections.filter((c) => c.id !== 'c2');
    expect(findRoute(buildGraph(m), { deviceId: 'laptop2' }, { deviceId: 'display1' })).toBeNull();
  });
});

describe('planActivity: Present', () => {
  const plan = planActivity(meeting(), activity(meeting(), 'present'), { sourceId: 'laptop2' });
  const find = (deviceId: string, type: string) =>
    plan.steps.filter((s) => s.deviceId === deviceId && s.command.type === type);

  it('has no problems and names the chosen source', () => {
    expect(plan.problems).toEqual([]);
    expect(plan.sourceDeviceId).toBe('laptop2');
  });

  it('powers both displays and unmutes the DSP', () => {
    expect(find('display1', 'power')[0]!.command).toEqual({ type: 'power', on: true });
    expect(find('display2', 'power')).toHaveLength(1);
    expect(find('dsp', 'mute')[0]!.command).toEqual({ type: 'mute', muted: false });
  });

  it('routes the chosen source to each display through the matrix', () => {
    const routes = plan.steps.filter((s) => s.deviceId === 'matrix').map((s) => s.command);
    expect(routes).toContainEqual({ type: 'route', inputPortId: 'in2', outputPortId: 'out1' });
    expect(routes).toContainEqual({ type: 'route', inputPortId: 'in2', outputPortId: 'out2' });
    expect(routes).not.toContainEqual(expect.objectContaining({ inputPortId: 'in1' }));
  });

  it('makes the audio follow the picture', () => {
    const routes = plan.steps.filter((s) => s.deviceId === 'matrix').map((s) => s.command);
    expect(routes).toContainEqual({ type: 'route', inputPortId: 'in2', outputPortId: 'out3' });
    expect(find('dsp', 'route')).toHaveLength(1);
  });

  it('selects the display input only after the display is powered', () => {
    const select = find('display1', 'select_input')[0]!;
    const power = find('display1', 'power')[0]!;
    expect(select.dependsOn).toContain(power.id);
  });

  it('honours explicit action dependencies (volume after unmute)', () => {
    const volume = find('dsp', 'volume')[0]!;
    expect(volume.dependsOn).toContain(find('dsp', 'mute')[0]!.id);
  });

  it('defaults to the first source', () => {
    const p = planActivity(meeting(), activity(meeting(), 'present'));
    expect(p.sourceDeviceId).toBe('laptop1');
  });

  it('every dependency refers to a step in the plan', () => {
    const ids = new Set(plan.steps.map((s) => s.id));
    for (const s of plan.steps) for (const d of s.dependsOn) expect(ids.has(d)).toBe(true);
  });
});

describe('planActivity: problems', () => {
  it('reports an unreachable display instead of throwing', () => {
    const m = meeting();
    m.connections = m.connections.filter((c) => c.id !== 'c4');
    const plan = planActivity(m, activity(m, 'present'));
    expect(plan.problems).toEqual([
      { code: 'no_route', message: 'Laptop 1 cannot reach Display 2' },
    ]);
  });

  it('reports a present activity with no sources', () => {
    const m = meeting();
    activity(m, 'present').sources = [];
    expect(planActivity(m, activity(m, 'present')).problems[0]!.code).toBe('no_source');
  });
});

describe('planActivity: Room Off', () => {
  it('expands the Off state into power-off and mute steps', () => {
    const m = meeting();
    const plan = planActivity(m, activity(m, 'room_off'));
    expect(plan.steps.map((s) => `${s.deviceId}:${s.command.type}`).sort()).toEqual([
      'display1:power',
      'display2:power',
      'dsp:mute',
    ]);
  });

  it('does not loop forever on a state that runs itself', () => {
    const m = meeting();
    m.states[0]!.actions.push({ id: 'loop', type: 'run_state', stateId: 'off', dependsOn: [] });
    expect(() => planActivity(m, activity(m, 'room_off'))).not.toThrow();
  });
});

describe('planActivity: Record (overlay)', () => {
  it('recalls the camera preset, routes the current source to the recorder and starts recording', () => {
    const m = training();
    const plan = planActivity(m, activity(m, 'record'), { currentSourceDeviceId: 'laptop1' });
    const cmds = plan.steps.map((s) => `${s.deviceId}:${JSON.stringify(s.command)}`);
    expect(cmds).toContain('camera:{"type":"camera_preset","name":"lectern"}');
    expect(cmds).toContain('recorder:{"type":"record","on":true}');
    expect(cmds).toContain('matrix:{"type":"route","inputPortId":"in1","outputPortId":"out4"}');
  });

  it('falls back to the camera when nothing is being presented', () => {
    const m = training();
    const plan = planActivity(m, activity(m, 'record'));
    expect(plan.steps.map((s) => s.command)).toContainEqual({
      type: 'route',
      inputPortId: 'in3',
      outputPortId: 'out4',
    });
  });

  it('stopping produces record-off only', () => {
    const m = training();
    const stop = planStopOverlay(m, activity(m, 'record'));
    expect(stop.steps.map((s) => [s.deviceId, s.command])).toEqual([
      ['recorder', { type: 'record', on: false }],
    ]);
  });
});
