import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomRuntime } from '@kestrel/engine';
import { STARTER_TEMPLATES, type DeviceBus, type RoomModel } from '@kestrel/model';
import { createSimulation, type Simulation } from './sim/simulation';

const meeting = (): RoomModel => structuredClone(STARTER_TEMPLATES[0]!.model);
const training = (): RoomModel =>
  structuredClone(STARTER_TEMPLATES.find((t) => t.id === 'training-recorded')!.model);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

let sim: Simulation;
let rt: RoomRuntime;
const setup = (model: RoomModel, bus?: (s: Simulation) => DeviceBus) => {
  sim = createSimulation(model);
  rt = new RoomRuntime({ model, roomName: 'Test room', bus: bus ? bus(sim) : sim });
};
const snap = () => rt.getSnapshot();
const activity = (id: string) => snap().activities.find((a) => a.id === id)!;
const text = () => snap().message?.text.key;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  rt.dispose();
  sim.dispose();
  vi.useRealTimers();
});

describe('what the panel offers', () => {
  it('the 90% room offers Present and Room Off, and hides what the room cannot do', () => {
    setup(meeting());
    expect(snap().activities.map((a) => a.name)).toEqual(['Present', 'Room Off']);
    expect(activity('present').sources.map((s) => s.label)).toEqual(['Laptop 1', 'Laptop 2']);
  });

  it('a training room with a recorder also offers Record, as an overlay', () => {
    setup(training());
    expect(snap().activities.map((a) => a.name)).toEqual(['Present', 'Record', 'Room Off']);
    expect(activity('record').overlay).toBe(true);
  });

  it('starts off, with plain-language guidance', () => {
    setup(meeting());
    expect(snap().status).toBe('off');
    expect(text()).toBe('room_off');
    expect(activity('room_off').active).toBe(true);
  });

  it('reports whether each source has a cable plugged in', () => {
    setup(meeting());
    sim.plug('laptop2', true);
    expect(activity('present').sources.map((s) => s.present)).toEqual([false, true]);
  });
});

describe('Present', () => {
  it('shows progress, then turns everything on and routes the chosen source', async () => {
    setup(meeting());
    rt.dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop2' });
    await advance(50);
    expect(snap().status).toBe('starting');
    expect(text()).toBe('starting');
    expect(activity('present').busy).toBe(true);

    await advance(3000);
    expect(snap().status).toBe('on');
    expect(sim.getState('display1')).toMatchObject({ power: 'on', selectedInput: 'in' });
    expect(sim.getState('display2')).toMatchObject({ power: 'on', selectedInput: 'in' });
    expect(sim.getState('matrix')!.routes).toEqual({ out1: 'in2', out2: 'in2', out3: 'in2' });
    expect(sim.getState('dsp')).toMatchObject({ muted: false, volume: 50 });
    expect(activity('present').sources.map((s) => s.selected)).toEqual([false, true]);
    expect(activity('present').active).toBe(true);
    expect(activity('room_off').active).toBe(false);
  });

  it('proceeds the moment devices are ready, with no fixed waits', async () => {
    setup(meeting());
    rt.dispatch({ type: 'activity.start', activityId: 'present' });
    await advance(2450);
    expect(snap().status).toBe('starting'); // displays still warming up
    // Displays are ready at 2500ms; the input select (100ms) finishes at 2600ms. Nothing else waits.
    await advance(160);
    expect(snap().status).toBe('on');
  });

  it('asks the person to plug in when the source has no cable', async () => {
    setup(meeting());
    rt.dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop1' });
    await advance(3000);
    expect(text()).toBe('plug_in_source');
    expect(snap().message).toMatchObject({
      tone: 'warn',
      text: { params: { source: 'Laptop 1' } },
    });
    sim.plug('laptop1', true);
    expect(text()).toBe('presenting');
  });

  it('the latest request wins when someone changes their mind mid-start', async () => {
    setup(meeting());
    rt.dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop1' });
    await advance(300);
    rt.dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop2' });
    await advance(5000);
    expect(snap().status).toBe('on');
    expect(sim.getState('matrix')!.routes.out1).toBe('in2');
    expect(activity('present').sources.map((s) => s.selected)).toEqual([false, true]);
  });

  it('switching source while presenting re-routes without a full restart', async () => {
    setup(meeting());
    rt.dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop1' });
    await advance(3000);
    rt.dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop2' });
    await advance(500);
    expect(snap().status).toBe('on');
    expect(sim.getState('matrix')!.routes.out1).toBe('in2');
  });
});

describe('Room Off', () => {
  it('turns the displays off and mutes', async () => {
    setup(meeting());
    rt.dispatch({ type: 'activity.start', activityId: 'present' });
    await advance(3000);
    rt.dispatch({ type: 'activity.start', activityId: 'room_off' });
    await advance(50);
    expect(snap().status).toBe('stopping');
    await advance(2000);
    expect(snap().status).toBe('off');
    expect(sim.getState('display1')!.power).toBe('off');
    expect(sim.getState('dsp')!.muted).toBe(true);
    expect(activity('present').active).toBe(false);
  });
});

describe('walk-in: signal detect', () => {
  it('starts Present with the right source when a laptop is plugged into an off room', async () => {
    setup(meeting());
    sim.plug('laptop2', true);
    await advance(3200);
    expect(snap().status).toBe('on');
    expect(activity('present').sources.find((s) => s.selected)!.id).toBe('laptop2');
    expect(text()).toBe('presenting');
  });

  it('ignores a signal that appears while the room is already starting', async () => {
    setup(meeting());
    rt.dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop1' });
    await advance(200);
    sim.plug('laptop2', true);
    await advance(3500);
    expect(snap().prompt).toBeNull();
    expect(snap().status).toBe('on');
  });
});

describe('second source prompt', () => {
  const presentingLaptop1 = async () => {
    setup(meeting());
    sim.plug('laptop1', true);
    await advance(3200);
    expect(snap().status).toBe('on');
  };

  it('asks before switching, then switches by itself after 10 seconds', async () => {
    await presentingLaptop1();
    sim.plug('laptop2', true);
    expect(snap().prompt).toMatchObject({
      text: { key: 'switch_source', params: { source: 'Laptop 2' } },
      secondsLeft: 10,
    });
    await advance(4000);
    expect(snap().prompt!.secondsLeft).toBe(6);
    expect(sim.getState('matrix')!.routes.out1).toBe('in1');
    await advance(6200);
    expect(snap().prompt).toBeNull();
    expect(sim.getState('matrix')!.routes.out1).toBe('in2');
  });

  it('switches at once when accepted', async () => {
    await presentingLaptop1();
    sim.plug('laptop2', true);
    rt.dispatch({ type: 'prompt.respond', promptId: snap().prompt!.id, accept: true });
    await advance(500);
    expect(snap().prompt).toBeNull();
    expect(sim.getState('matrix')!.routes.out1).toBe('in2');
  });

  it('keeps the current source when declined, and does not switch later', async () => {
    await presentingLaptop1();
    sim.plug('laptop2', true);
    rt.dispatch({ type: 'prompt.respond', promptId: snap().prompt!.id, accept: false });
    await advance(15_000);
    expect(snap().prompt).toBeNull();
    expect(sim.getState('matrix')!.routes.out1).toBe('in1');
  });

  it('drops the prompt if the new laptop is unplugged again', async () => {
    await presentingLaptop1();
    sim.plug('laptop2', true);
    sim.plug('laptop2', false);
    expect(snap().prompt).toBeNull();
    await advance(15_000);
    expect(sim.getState('matrix')!.routes.out1).toBe('in1');
  });

  it('ignores a stale prompt id', async () => {
    await presentingLaptop1();
    sim.plug('laptop2', true);
    rt.dispatch({ type: 'prompt.respond', promptId: 'nope', accept: false });
    expect(snap().prompt).not.toBeNull();
  });
});

describe('idle and auto-off', () => {
  const quick = () => {
    const m = meeting();
    m.settings.autoOff = { enabled: true, warnSeconds: 5, idleSeconds: 10 };
    return m;
  };
  const presenting = async (m = quick()) => {
    setup(m);
    sim.plug('laptop1', true);
    await advance(3200);
    expect(snap().status).toBe('on');
  };

  it('warns after the idle time with no signal, then turns the room off', async () => {
    await presenting();
    sim.plug('laptop1', false);
    await advance(9000);
    expect(snap().warning).toBeNull();
    await advance(1500);
    expect(snap().warning).toMatchObject({ text: { key: 'auto_off' } });
    expect(snap().warning!.secondsLeft).toBeLessThanOrEqual(5);
    await advance(5500);
    await advance(2000);
    expect(snap().status).toBe('off');
    expect(sim.getState('display1')!.power).toBe('off');
  });

  it('cancels the countdown if the signal comes back', async () => {
    await presenting();
    sim.plug('laptop1', false);
    await advance(11_000);
    expect(snap().warning).not.toBeNull();
    sim.plug('laptop1', true);
    expect(snap().warning).toBeNull();
    await advance(20_000);
    expect(snap().status).toBe('on');
  });

  it('cancels the countdown when someone touches the panel', async () => {
    await presenting();
    sim.plug('laptop1', false);
    await advance(11_000);
    rt.dispatch({ type: 'volume.bump', delta: 5 });
    expect(snap().warning).toBeNull();
    await advance(4000);
    expect(snap().status).toBe('on');
  });

  it('"stay on" dismisses the warning and re-arms the timer', async () => {
    await presenting();
    sim.plug('laptop1', false);
    await advance(11_000);
    rt.dispatch({ type: 'warning.dismiss' });
    expect(snap().warning).toBeNull();
    await advance(11_000);
    expect(snap().warning).not.toBeNull();
  });

  it('never turns off when auto-off is disabled', async () => {
    const m = quick();
    m.settings.autoOff.enabled = false;
    await presenting(m);
    sim.plug('laptop1', false);
    await advance(60_000);
    expect(snap().status).toBe('on');
    expect(snap().warning).toBeNull();
  });

  it('never turns off when the room cannot detect signal', async () => {
    const m = quick();
    setup(m, (s) => ({
      send: (id, c) => s.send(id, c),
      subscribe: (l) => s.subscribe(l),
      // A room whose gear reports no signal information at all.
      getState: (id) => {
        const st = s.getState(id);
        return st && { ...st, signal: {} };
      },
    }));
    rt.dispatch({ type: 'activity.start', activityId: 'present' });
    await advance(3200);
    expect(snap().status).toBe('on');
    expect(activity('present').sources.map((s) => s.present)).toEqual([null, null]);
    await advance(120_000);
    expect(snap().status).toBe('on');
    expect(snap().warning).toBeNull();
  });
});

describe('faults', () => {
  it('names the device that failed in plain language and keeps working on the rest', async () => {
    setup(meeting());
    sim.setFault('display2', { offline: true });
    rt.dispatch({ type: 'activity.start', activityId: 'present' });
    await advance(4000);
    expect(snap().status).toBe('fault');
    expect(snap().message).toMatchObject({
      tone: 'error',
      text: { key: 'fault_device', params: { device: 'Display 2' } },
    });
    expect(sim.getState('display1')!.power).toBe('on'); // independent steps still ran
  });

  it('recovers when the device comes back and the person tries again', async () => {
    setup(meeting());
    sim.setFault('display2', { offline: true });
    rt.dispatch({ type: 'activity.start', activityId: 'present' });
    await advance(4000);
    sim.setFault('display2', null);
    rt.dispatch({ type: 'activity.start', activityId: 'present' });
    await advance(4000);
    expect(snap().status).toBe('on');
  });

  it('reports a design problem instead of half-starting', async () => {
    const m = meeting();
    m.connections = m.connections.filter((c) => c.id !== 'c4');
    setup(m);
    rt.dispatch({ type: 'activity.start', activityId: 'present' });
    await advance(100);
    expect(snap().status).toBe('fault');
    expect(sim.getState('display1')!.power).toBe('off');
  });

  it('a step that never reports ready times out into a fault', async () => {
    const m = meeting();
    sim = createSimulation(m);
    rt = new RoomRuntime({
      model: m,
      roomName: 'x',
      stepTimeoutMs: 4000,
      bus: {
        send: (id, c) => (id === 'dsp' ? new Promise(() => undefined) : sim.send(id, c)),
        getState: (id) => sim.getState(id),
        subscribe: (l) => sim.subscribe(l),
      },
    });
    rt.dispatch({ type: 'activity.start', activityId: 'present' });
    await advance(4500);
    expect(snap().status).toBe('fault');
    expect(snap().message!.text.params).toMatchObject({ device: 'DSP' });
  });
});

describe('Record (overlay)', () => {
  it('records the presentation alongside it, then stops and confirms', async () => {
    setup(training());
    sim.plug('laptop1', true);
    await advance(3200);
    rt.dispatch({ type: 'activity.start', activityId: 'record' });
    await advance(1500);
    expect(sim.getState('recorder')!.recording).toBe(true);
    expect(sim.getState('camera')!.preset).toBe('lectern');
    expect(sim.getState('matrix')!.routes.out4).toBe('in1');
    expect(activity('record').active).toBe(true);
    expect(activity('present').active).toBe(true); // still presenting
    expect(text()).toBe('recording');

    rt.dispatch({ type: 'activity.stop', activityId: 'record' });
    await advance(600);
    expect(sim.getState('recorder')!.recording).toBe(false);
    expect(activity('record').active).toBe(false);
    expect(text()).toBe('recording_saved');
    await advance(4500);
    expect(text()).toBe('presenting');
  });

  it('can record with the room otherwise off, using the camera', async () => {
    setup(training());
    rt.dispatch({ type: 'activity.start', activityId: 'record' });
    await advance(1500);
    expect(sim.getState('recorder')!.recording).toBe(true);
    expect(sim.getState('matrix')!.routes.out4).toBe('in3');
    expect(snap().status).toBe('on');
  });

  it('Room Off also stops a running recording', async () => {
    setup(training());
    sim.plug('laptop1', true);
    await advance(3200);
    rt.dispatch({ type: 'activity.start', activityId: 'record' });
    await advance(1500);
    rt.dispatch({ type: 'activity.start', activityId: 'room_off' });
    await advance(3000);
    expect(snap().status).toBe('off');
    expect(sim.getState('recorder')!.recording).toBe(false);
    expect(activity('record').active).toBe(false);
  });
});

describe('volume', () => {
  it('bumps and sets volume, and shows numeric feedback', async () => {
    setup(meeting());
    rt.dispatch({ type: 'volume.bump', delta: 10 });
    await advance(200);
    expect(snap().volume).toMatchObject({ available: true, level: 60, muted: false });
    expect(sim.getState('dsp')!.volume).toBe(60);
    rt.dispatch({ type: 'volume.set', level: 30 });
    await advance(200);
    expect(sim.getState('dsp')!.volume).toBe(30);
  });

  it('clamps to 0-100', async () => {
    setup(meeting());
    rt.dispatch({ type: 'volume.bump', delta: 25 });
    rt.dispatch({ type: 'volume.bump', delta: 25 });
    rt.dispatch({ type: 'volume.bump', delta: 25 });
    rt.dispatch({ type: 'volume.bump', delta: 25 });
    rt.dispatch({ type: 'volume.bump', delta: 25 });
    expect(snap().volume.level).toBe(100);
    for (let i = 0; i < 6; i++) rt.dispatch({ type: 'volume.bump', delta: -25 });
    expect(snap().volume.level).toBe(0);
  });

  it('coalesces a press-and-hold ramp into a few commands, ending on the right level', async () => {
    setup(meeting());
    const send = vi.spyOn(sim, 'send');
    for (let i = 0; i < 20; i++) rt.dispatch({ type: 'volume.bump', delta: 1 });
    await advance(1000);
    expect(sim.getState('dsp')!.volume).toBe(70);
    const volumeCalls = send.mock.calls.filter(([, c]) => c.type === 'volume').length;
    expect(volumeCalls).toBeLessThan(6);
  });

  it('mutes and unmutes', async () => {
    setup(meeting());
    rt.dispatch({ type: 'mute.set', muted: false });
    await advance(200);
    expect(sim.getState('dsp')!.muted).toBe(false);
    rt.dispatch({ type: 'mute.set', muted: true });
    await advance(200);
    expect(snap().volume.muted).toBe(true);
    expect(sim.getState('dsp')!.muted).toBe(true);
  });
});

describe('multiple panels', () => {
  it('every subscriber sees the same state change, whichever panel acted', async () => {
    setup(meeting());
    const a: string[] = [];
    const b: string[] = [];
    rt.subscribe(() => a.push(snap().status));
    rt.subscribe(() => b.push(snap().status));
    rt.dispatch({ type: 'activity.start', activityId: 'present' });
    await advance(3200);
    expect(a.length).toBeGreaterThan(1);
    expect(a).toEqual(b);
    expect(a.at(-1)).toBe('on');
  });

  it('hands out a stable snapshot until something changes', () => {
    setup(meeting());
    expect(snap()).toBe(snap());
  });

  it('works when a panel passes its methods around as callbacks', async () => {
    setup(training());
    const { dispatch, getSnapshot, subscribe } = rt;
    const seen: string[] = [];
    subscribe(() => seen.push(getSnapshot().status));
    dispatch({ type: 'activity.start', activityId: 'record' });
    await advance(1500);
    expect(sim.getState('recorder')!.recording).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('ignores malformed intents from a misbehaving panel', () => {
    setup(meeting());
    const before = snap();
    rt.dispatch({ type: 'volume.set', level: 9999 });
    rt.dispatch({ type: 'activity.start', activityId: 'does-not-exist' });
    rt.dispatch({ type: 'nonsense' } as never);
    expect(snap()).toBe(before);
  });
});

describe('triggers', () => {
  const withSensor = (extra: Partial<RoomModel> = {}): RoomModel => {
    const m = meeting();
    m.devices.push({
      id: 'sensor',
      name: 'Room sensor',
      category: 'occupancy_sensor',
      ports: [],
      extraCapabilities: [],
      settings: {},
    });
    Object.assign(m, extra);
    return m;
  };
  const trigger = (t: Record<string, unknown>) =>
    ({
      id: 't1',
      name: 'T',
      enabled: true,
      run: { type: 'activity', activityId: 'present' },
      ...t,
    }) as RoomModel['triggers'][number];

  it('an external call (webhook) runs what the trigger points at, by name', async () => {
    const m = meeting();
    m.triggers.push(trigger({ type: 'webhook', hookName: 'start_present' }));
    setup(m);
    expect(rt.fireHook('nope')).toBe(0);
    expect(rt.fireHook('start_present')).toBe(1);
    await advance(3000);
    expect(snap().status).toBe('on');
    expect(activity('present').active).toBe(true);
  });

  it('a disabled webhook does nothing', async () => {
    const m = meeting();
    m.triggers.push(trigger({ type: 'webhook', hookName: 'start_present', enabled: false }));
    setup(m);
    expect(rt.fireHook('start_present')).toBe(0);
    await advance(3000);
    expect(snap().status).toBe('off');
  });

  it('a trigger can run a state, and an "off" state turns the room off', async () => {
    const m = meeting();
    m.states.push({ id: 'after_hours', name: 'After hours', kind: 'off', actions: [] });
    m.triggers.push(
      trigger({
        type: 'webhook',
        hookName: 'close',
        run: { type: 'state', stateId: 'after_hours' },
      }),
    );
    setup(m);
    rt.dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop1' });
    await advance(3000);
    expect(snap().status).toBe('on');
    rt.fireHook('close');
    await advance(3000);
    expect(snap().status).toBe('off');
    expect(sim.getState('display1')!.power).toBe('off');
  });

  it('a custom state runs its device commands without touching what is showing', async () => {
    const m = meeting();
    m.states.push({
      id: 'quiet',
      name: 'Quiet',
      kind: 'custom',
      actions: [{ id: 'a1', type: 'volume', deviceId: 'dsp', level: 20, dependsOn: [] }],
    });
    m.triggers.push(
      trigger({ type: 'webhook', hookName: 'quiet', run: { type: 'state', stateId: 'quiet' } }),
    );
    setup(m);
    rt.fireHook('quiet');
    await advance(3000);
    expect(sim.getState('dsp')!.volume).toBe(20);
    expect(snap().status).toBe('off');
  });

  it('someone walking in starts the room; leaving can turn it off', async () => {
    const m = withSensor();
    m.triggers.push(
      trigger({ id: 'in', type: 'occupancy', deviceId: 'sensor', occupied: true }),
      trigger({
        id: 'out',
        type: 'occupancy',
        deviceId: 'sensor',
        occupied: false,
        run: { type: 'activity', activityId: 'room_off' },
      }),
    );
    setup(m);
    sim.setOccupied('sensor', true);
    await advance(3000);
    expect(snap().status).toBe('on');
    sim.setOccupied('sensor', false);
    await advance(3000);
    expect(snap().status).toBe('off');
  });

  it('occupancy fires on a change, not on every report', async () => {
    const m = withSensor();
    m.triggers.push(trigger({ type: 'occupancy', deviceId: 'sensor', occupied: true }));
    setup(m);
    const spy = vi.spyOn(rt, 'fire');
    sim.setOccupied('sensor', false);
    sim.setOccupied('sensor', true);
    sim.setOccupied('sensor', true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
