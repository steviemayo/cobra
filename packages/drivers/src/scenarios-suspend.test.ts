import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomRuntime } from '@kestrel/engine';
import { STARTER_TEMPLATES, type RoomModel } from '@kestrel/model';
import { createSimulation, type Simulation } from './sim/simulation';

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

let sim: Simulation;
let rt: RoomRuntime;
const setup = (model: RoomModel = structuredClone(STARTER_TEMPLATES[0]!.model)) => {
  sim = createSimulation(model);
  rt = new RoomRuntime({ model, roomName: 'Test room', bus: sim });
};
const snap = () => rt.getSnapshot();
const selected = () =>
  snap()
    .activities.find((a) => a.id === 'present')!
    .sources.find((s) => s.selected)?.id;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  rt.dispose();
  sim.dispose();
  vi.useRealTimers();
});

describe('a suspended room', () => {
  it('ignores its panel, triggers and signal, and leaves the devices alone', async () => {
    setup();
    rt.suspend();
    expect(rt.isSuspended).toBe(true);
    rt.dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop1' });
    rt.fire({ type: 'activity', activityId: 'present' });
    expect(rt.fireHook('anything')).toBe(0);
    expect(rt.fireTrigger('anything')).toBe(false);
    sim.plug('laptop2', true);
    await advance(4000);
    expect(snap().status).toBe('off');
    expect(sim.getState('display1')!.power).toBe('off');
  });

  it('remembers what the room was doing', async () => {
    setup();
    rt.dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop2' });
    await advance(3000);
    const parked = rt.suspend();
    expect(parked).toEqual({
      on: true,
      primary: { activityId: 'present', sourceId: 'laptop2' },
      overlays: [],
    });
    // Suspending twice does not lose it.
    expect(rt.suspend().on).toBe(true);
  });

  it('abandons a start that is still in progress', async () => {
    setup();
    rt.dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop1' });
    await advance(500);
    expect(snap().status).toBe('starting');
    const parked = rt.suspend();
    expect(parked.on).toBe(true);
    await advance(4000);
    // The abandoned start must not finish and claim the room.
    expect(snap().status).toBe('starting');
    expect(selected()).toBeUndefined();
    rt.resume();
    // No activity is chosen; a display that is warming up counts as the room being on.
    expect(selected()).toBeUndefined();
  });

  it('does not run auto-off while suspended', async () => {
    const m = structuredClone(STARTER_TEMPLATES[0]!.model);
    m.settings.autoOff = { enabled: true, warnSeconds: 5, idleSeconds: 10 };
    setup(m);
    sim.plug('laptop1', true);
    await advance(3200);
    expect(snap().status).toBe('on');
    sim.plug('laptop1', false);
    await advance(2000);
    rt.suspend();
    await advance(30_000);
    expect(snap().warning).toBeNull();
    expect(sim.getState('display1')!.power).toBe('on');
  });
});

describe('taking a room back', () => {
  it('forgets which activity it was showing, whatever it believed before', async () => {
    setup();
    rt.dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop1' });
    await advance(3000);
    rt.suspend();
    rt.resume();
    expect(snap().activities.find((a) => a.id === 'present')!.active).toBe(false);
    expect(selected()).toBeUndefined();
    // But it still reads the devices: they are on, so the room is on.
    expect(snap().status).toBe('on');
  });

  it('answers its panel again once resumed', async () => {
    setup();
    rt.suspend();
    rt.resume();
    rt.dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop1' });
    await advance(3000);
    expect(snap().status).toBe('on');
  });

  it('turns on, or off even when it thinks it is already off', async () => {
    setup();
    rt.suspend();
    rt.resume();
    void rt.turnOn();
    await advance(3000);
    expect(snap().status).toBe('on');
    expect(sim.getState('display1')!.power).toBe('on');

    // Someone else ran the devices meanwhile; turning off does not trust what this room believed.
    rt.suspend();
    rt.resume();
    void rt.turnOff();
    await advance(3000);
    expect(sim.getState('display1')!.power).toBe('off');
  });

  it('restores what it was doing, or turns off if it was off', async () => {
    setup();
    rt.dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop2' });
    await advance(3000);
    const parked = rt.suspend();
    rt.resume();
    void rt.restore(parked);
    await advance(3500);
    expect(snap().status).toBe('on');
    expect(selected()).toBe('laptop2');

    const off = rt.suspend();
    rt.resume();
    void rt.restore({ ...off, on: false });
    await advance(3000);
    expect(snap().status).toBe('off');
    expect(sim.getState('display1')!.power).toBe('off');
    void rt.restore(undefined);
    await advance(1000);
    expect(snap().status).toBe('off');
  });
});

describe('the Room linking view', () => {
  it('appears once set, and is dropped when cleared', () => {
    setup();
    expect(snap().linking).toBeUndefined();
    const linking = { space: ['Room A'], dividers: [] };
    rt.setLinking(linking);
    expect(snap().linking).toEqual(linking);
    rt.setLinking(null);
    expect(snap().linking).toBeUndefined();
  });

  it('passes a wall request from the panel out, and only when running', () => {
    const asked: [string, boolean][] = [];
    const model = structuredClone(STARTER_TEMPLATES[0]!.model);
    sim = createSimulation(model);
    rt = new RoomRuntime({
      model,
      roomName: 'Test room',
      bus: sim,
      onDivider: (id, open) => asked.push([id, open]),
    });
    rt.dispatch({ type: 'divider.set', dividerId: 'w1', open: true });
    rt.suspend();
    rt.dispatch({ type: 'divider.set', dividerId: 'w2', open: true });
    expect(asked).toEqual([['w1', true]]);
  });
});
