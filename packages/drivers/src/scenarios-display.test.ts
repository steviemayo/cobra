import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomRuntime, validateRoomModel } from '@kestrel/engine';
import { STARTER_TEMPLATES, gatewayNeeds, type RoomModel } from '@kestrel/model';
import { createSimulation, type Simulation } from './sim/simulation';

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const APPS = [
  { id: 'app.netflix', name: 'Netflix' },
  { id: 'app.signage', name: 'Signage' },
];

/** The starter room with its display driven by the Sony BRAVIA driver and the Display page on. */
function smartRoom(over: { control?: RoomModel['devices'][number]['control']; on?: boolean } = {}): RoomModel {
  const m = structuredClone(STARTER_TEMPLATES[0]!.model);
  m.settings.userControls.display = over.on ?? true;
  const tv = m.devices.find((d) => d.category === 'video_destination' || d.category === 'display')!;
  tv.control = over.control ?? { kind: 'driver', driverId: 'lib:sony-bravia' };
  tv.settings = { apps: APPS };
  return m;
}

let sim: Simulation;
let rt: RoomRuntime;
const setup = (model: RoomModel) => {
  sim = createSimulation(model);
  rt = new RoomRuntime({ model, roomName: 'Test room', bus: sim });
};
const displays = () => rt.getSnapshot().functions?.displays;
const tvId = (m: RoomModel) => m.devices.find((d) => d.category === 'video_destination' || d.category === 'display')!.id;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  rt.dispose();
  sim.dispose();
  vi.useRealTimers();
});

describe('the display page', () => {
  it('is offered when the room turns it on and the display driver has keys and apps', () => {
    const m = smartRoom();
    setup(m);
    expect(displays()).toEqual([
      { id: tvId(m), name: expect.any(String), keys: true, media: true, apps: APPS, activeApp: null },
    ]);
  });

  it('is not offered when the room has it off', () => {
    setup(smartRoom({ on: false }));
    expect(rt.getSnapshot().functions).toBeUndefined();
  });

  it('is not offered for a display whose driver declares none of it', () => {
    setup(smartRoom({ control: { kind: 'generic', protocol: 'pjlink' } }));
    expect(rt.getSnapshot().functions).toBeUndefined();
  });

  it('lists only the apps a driver with the apps feature can launch, and drops malformed entries', () => {
    const m = smartRoom();
    m.devices.find((d) => d.id === tvId(m))!.settings.apps = [...APPS, { id: 'app.netflix', name: 'Dup' }, { name: 'No id' }, 'junk'];
    setup(m);
    expect(displays()![0]!.apps).toEqual(APPS);
  });
});

describe('panel intents', () => {
  it('pressing a key and launching an app reach the display once it is on', async () => {
    const m = smartRoom();
    setup(m);
    const id = tvId(m);
    const sent: unknown[] = [];
    const send = sim.send.bind(sim);
    sim.send = async (deviceId, command) => {
      if (deviceId === id && (command.type === 'key' || command.type === 'launch_app')) sent.push(command);
      return send(deviceId, command);
    };
    const powered = sim.send(id, { type: 'power', on: true });
    await advance(20_000);
    await powered;
    rt.dispatch({ type: 'display.key', deviceId: id, key: 'home' });
    rt.dispatch({ type: 'display.key', deviceId: id, key: 'pause' });
    rt.dispatch({ type: 'display.app', deviceId: id, appId: 'app.netflix' });
    await advance(5000);
    expect(sent).toEqual([
      { type: 'key', key: 'home' },
      { type: 'key', key: 'pause' },
      { type: 'launch_app', appId: 'app.netflix' },
    ]);
    expect(displays()![0]!.activeApp).toBe('app.netflix');
  });

  it('ignores an app that is not in the list, a display that is not on the page, and a key the driver lacks', async () => {
    const m = smartRoom();
    setup(m);
    const id = tvId(m);
    const spy = vi.spyOn(sim, 'send');
    rt.dispatch({ type: 'display.app', deviceId: id, appId: 'app.unknown' });
    rt.dispatch({ type: 'display.key', deviceId: 'nope', key: 'home' });
    await advance(1000);
    expect(spy).not.toHaveBeenCalled();
    rt.dispose();
    sim.dispose();
    setup(smartRoom({ on: false }));
    const off = vi.spyOn(sim, 'send');
    rt.dispatch({ type: 'display.key', deviceId: id, key: 'home' });
    await advance(1000);
    expect(off).not.toHaveBeenCalled();
  });
});

describe('press key and launch app actions', () => {
  const withActivity = (m: RoomModel) => {
    const id = tvId(m);
    const present = m.activities.find((a) => a.kind === 'present') ?? m.activities[0]!;
    present.actions.push(
      { id: 'sig-app', type: 'launch_app', deviceId: id, appId: 'app.signage', dependsOn: [] },
      { id: 'sig-key', type: 'press_key', deviceId: id, key: 'home', dependsOn: ['sig-app'] },
    );
    return { id, activityId: present.id };
  };

  it('run in an activity, after the display is on', async () => {
    const m = smartRoom();
    const { id, activityId } = withActivity(m);
    setup(m);
    const sent: string[] = [];
    const send = sim.send.bind(sim);
    sim.send = async (deviceId, command) => {
      if (deviceId === id) sent.push(command.type);
      return send(deviceId, command);
    };
    rt.dispatch({ type: 'activity.start', activityId });
    await advance(30_000);
    expect(sent.indexOf('power')).toBeLessThan(sent.indexOf('launch_app'));
    expect(sent.indexOf('launch_app')).toBeLessThan(sent.indexOf('key'));
  });

  it('need a display with a driver, and make a release that needs a newer gateway', () => {
    const m = smartRoom({ control: undefined });
    delete m.devices.find((d) => d.id === tvId(m))!.control;
    withActivity(m);
    const issues = validateRoomModel(m).issues.filter((i) => i.message.includes('no driver, so it cannot'));
    expect(issues.length).toBeGreaterThan(0);
    expect(gatewayNeeds(m)).toEqual(['display-extras']);
    expect(gatewayNeeds(STARTER_TEMPLATES[0]!.model)).toEqual([]);
  });

  it('are refused on something that is not a display', () => {
    const m = smartRoom();
    const { activityId } = withActivity(m);
    m.activities.find((a) => a.id === activityId)!.actions.push({ id: 'bad', type: 'press_key', deviceId: m.devices.find((d) => d.category === 'video_matrix')!.id, key: 'up', dependsOn: [] });
    expect(validateRoomModel(m).issues.some((i) => i.message.includes('is not a display'))).toBe(true);
  });
});
