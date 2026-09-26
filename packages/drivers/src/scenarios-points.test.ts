import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomRuntime, validateRoomModel } from '@kestrel/engine';
import { STARTER_TEMPLATES, gatewayNeeds, type ControlPoint, type Device, type RoomModel } from '@kestrel/model';
import { createSimulation, type Simulation } from './sim/simulation';

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const point = (over: Partial<ControlPoint> & Pick<ControlPoint, 'id' | 'type'>): ControlPoint => ({
  name: over.id,
  address: { component: 'C', control: over.id },
  ...over,
});

const mic = (id: string, category: Device['category'] = 'reinforcement_mic'): Device => ({
  id,
  name: id,
  category,
  ports: [],
  extraCapabilities: [],
  settings: {},
});

/** The starter room with a Q-SYS DSP holding the given points, plus microphones with no driver of their own. */
function room(points: ControlPoint[], mics: Device[] = [mic('lectern'), mic('ceiling', 'voice_capture_mic')]): RoomModel {
  const m = structuredClone(STARTER_TEMPLATES[0]!.model);
  m.settings.userControls.microphones = true;
  const dsp = m.devices.find((d) => d.id === 'dsp')!;
  dsp.control = { kind: 'driver', driverId: 'qsys-core' };
  dsp.points = points;
  m.devices.push(...mics);
  return m;
}

let sim: Simulation;
let rt: RoomRuntime;
const setup = (model: RoomModel) => {
  sim = createSimulation(model);
  rt = new RoomRuntime({ model, roomName: 'Test room', bus: sim });
};
const pts = () => sim.getState('dsp')!.points;
const mics = () => rt.getSnapshot().functions?.microphones ?? [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  rt.dispose();
  sim.dispose();
  vi.useRealTimers();
});

const lecternPoints = [
  point({ id: 'lvl', type: 'level', role: 'mic_level', targetId: 'lectern', min: -40, max: 0 }),
  point({ id: 'mut', type: 'mute', role: 'mic_mute', targetId: 'lectern' }),
];

describe('a microphone controlled through DSP points', () => {
  it('appears on the Microphones page with volume and mute, though it has no driver of its own', () => {
    setup(room(lecternPoints));
    expect(mics()).toEqual([{ id: 'lectern', name: 'lectern', muted: false, canVolume: true, volume: 50 }]);
  });

  it('mutes and nudges the volume by setting the points on the DSP', async () => {
    setup(room(lecternPoints));
    rt.dispatch({ type: 'mic.mute', deviceId: 'lectern', muted: true });
    rt.dispatch({ type: 'mic.bump', deviceId: 'lectern', delta: 10 });
    await advance(2000);
    expect(pts()).toMatchObject({ mut: true, lvl: 60 });
    expect(mics()[0]).toMatchObject({ muted: true, volume: 60 });
  });

  it('follows the room: unmuted when it turns on, muted when it turns off', async () => {
    const m = room(lecternPoints);
    setup(m);
    void sim.send('dsp', { type: 'point', pointId: 'mut', value: true });
    await advance(1000);
    rt.dispatch({ type: 'activity.start', activityId: m.activities.find((a) => a.kind === 'present')!.id });
    await advance(30_000);
    expect(pts().mut).toBe(false);
    rt.dispatch({ type: 'activity.start', activityId: m.activities.find((a) => a.kind === 'room_off')!.id });
    await advance(30_000);
    expect(pts().mut).toBe(true);
  });

  it('is not offered when the microphone has neither a driver nor a point', () => {
    setup(room([]));
    expect(rt.getSnapshot().functions).toBeUndefined();
  });

  it('a microphone with its own driver keeps it, and the point is ignored', async () => {
    const own = { ...mic('lectern'), control: { kind: 'generic', protocol: 'tcp' } as const };
    setup(room(lecternPoints, [own]));
    expect(mics()[0]).toMatchObject({ canVolume: false });
    const spy = vi.spyOn(sim, 'send');
    rt.dispatch({ type: 'mic.mute', deviceId: 'lectern', muted: true });
    await advance(1000);
    expect(spy).toHaveBeenCalledWith('lectern', { type: 'mute', muted: true });
  });
});

describe('Privacy Mute through a point', () => {
  const privacy = point({ id: 'priv', type: 'mute', role: 'mic_privacy_mute', targetId: 'ceiling' });
  const quick = () =>
    (rt.getSnapshot().quickActions ?? []).filter((q) => q.id === 'mics.privacy_mute').map((q) => q.active);

  it('is offered and mutes the point, and shows its state', async () => {
    setup(room([privacy]));
    expect(quick()).toEqual([false]);
    rt.dispatch({ type: 'quickaction.run', id: 'mics.privacy_mute', active: true });
    await advance(2000);
    expect(pts().priv).toBe(true);
    expect(quick()).toEqual([true]);
    rt.dispatch({ type: 'quickaction.run', id: 'mics.privacy_mute' });
    await advance(2000);
    expect(pts().priv).toBe(false);
  });
});

describe('room volume through points', () => {
  it('the panel volume and mute set the points with the room roles', async () => {
    const m = room([
      point({ id: 'vol', type: 'level', role: 'room_volume', min: -60, max: 0 }),
      point({ id: 'mute', type: 'mute', role: 'room_mute' }),
    ]);
    setup(m);
    void sim.send('dsp', { type: 'volume', level: 30 });
    void sim.send('dsp', { type: 'mute', muted: true });
    await advance(2000);
    expect(pts()).toMatchObject({ vol: 30, mute: true });
  });
});

describe('checking control points', () => {
  const issues = (m: RoomModel, text: string) => validateRoomModel(m).issues.filter((i) => i.message.includes(text));

  it('needs each part of the address the driver asks for', () => {
    const m = room([point({ id: 'a', type: 'level', address: { component: 'C' } })]);
    expect(issues(m, 'control name')).toHaveLength(1);
  });

  it('refuses a kind of point the driver does not support', () => {
    const m = room([point({ id: 'a', type: 'crosspoint' })]);
    expect(issues(m, 'does not support crosspoint')).toHaveLength(1);
  });

  it('needs a role to fit the kind of point, and a microphone of the right kind to act on', () => {
    const m = room([
      point({ id: 'a', type: 'mute', role: 'room_volume' }),
      point({ id: 'b', type: 'mute', role: 'mic_mute', targetId: 'nobody' }),
      point({ id: 'c', type: 'mute', role: 'mic_privacy_mute', targetId: 'lectern' }),
    ]);
    expect(issues(m, 'needs a level point')).toHaveLength(1);
    expect(issues(m, 'needs a reinforcement microphone')).toHaveLength(1);
    expect(issues(m, 'needs a conferencing microphone')).toHaveLength(1);
  });

  it('warns about a role used twice and about a microphone that has its own driver', () => {
    const own = { ...mic('lectern'), control: { kind: 'generic', protocol: 'tcp' } as const };
    const m = room(
      [
        point({ id: 'a', type: 'level', role: 'room_volume' }),
        point({ id: 'b', type: 'level', role: 'room_volume' }),
        point({ id: 'c', type: 'mute', role: 'mic_mute', targetId: 'lectern' }),
      ],
      [own],
    );
    expect(issues(m, 'already has a').map((i) => i.severity)).toEqual(['warning']);
    expect(issues(m, 'has its own driver').map((i) => i.severity)).toEqual(['warning']);
  });

  it('refuses a duplicate point id, a backwards range, and points on a device that cannot have them', () => {
    const m = room([
      point({ id: 'a', type: 'level', min: 0, max: -10 }),
      point({ id: 'a', type: 'mute' }),
    ]);
    m.devices.find((d) => d.category === 'video_matrix')!.points = [point({ id: 'z', type: 'mute' })];
    expect(issues(m, 'share the id')).toHaveLength(1);
    expect(issues(m, 'minimum must be below')).toHaveLength(1);
    expect(issues(m, 'cannot have control points')).toHaveLength(1);
  });

  it('a room with points needs a gateway that says it can run them', () => {
    expect(gatewayNeeds(room(lecternPoints))).toEqual(['control-points']);
    expect(gatewayNeeds(room([]))).toEqual([]);
  });

  it('accepts a good set of points', () => {
    const m = room(lecternPoints);
    expect(validateRoomModel(m).issues.filter((i) => i.message.includes('control point') || i.message.includes('point "'))).toEqual([]);
  });
});
