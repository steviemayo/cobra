import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomRuntime } from '@kestrel/engine';
import { STARTER_TEMPLATES, type Device, type RoomModel } from '@kestrel/model';
import { createSimulation, type Simulation } from './sim/simulation';

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const device = (over: Partial<Device> & Pick<Device, 'id' | 'name' | 'category'>): Device => ({
  ports: [],
  extraCapabilities: [],
  settings: {},
  ...over,
});
const driver = { kind: 'generic', protocol: 'tcp' } as const;

/** The starter room plus a camera, lights, blinds, a screen and a microphone, all with drivers. */
const equipped = (
  controls: Partial<RoomModel['settings']['userControls']> = {
    lights: true,
    blinds: true,
    camera: true,
    microphones: true,
  },
): RoomModel => {
  const m = structuredClone(STARTER_TEMPLATES[0]!.model);
  m.settings.userControls = {
    lights: false,
    blinds: false,
    camera: false,
    microphones: false,
    display: false,
    ...controls,
  };
  m.devices.push(
    device({
      id: 'ptz1',
      name: 'Front camera',
      category: 'ptz_camera',
      ports: [{ id: 'out', name: 'Output', direction: 'out', signal: 'video' }],
      control: { kind: 'driver', driverId: 'visca-ip' },
      settings: { presets: { Wide: 0, Podium: 1 } },
    }),
    device({
      id: 'lights1',
      name: 'Room lights',
      category: 'lighting',
      control: driver,
      settings: { scenes: ['Bright', 'Dim'] },
    }),
    device({ id: 'blinds1', name: 'Window blinds', category: 'blinds', control: driver }),
    device({ id: 'screen1', name: 'Projection screen', category: 'screen', control: driver }),
    device({ id: 'mic1', name: 'Lectern mic', category: 'reinforcement_mic', control: driver }),
    device({ id: 'mic2', name: 'Ceiling mic', category: 'voice_capture_mic', control: driver }),
  );
  return m;
};

let sim: Simulation;
let rt: RoomRuntime;
const setup = (model: RoomModel) => {
  sim = createSimulation(model);
  rt = new RoomRuntime({ model, roomName: 'Test room', bus: sim });
};
const fn = () => rt.getSnapshot().functions;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  rt.dispose();
  sim.dispose();
  vi.useRealTimers();
});

describe('which pages a room offers', () => {
  it('none unless the room enables them', () => {
    setup(equipped({}));
    expect(fn()).toBeUndefined();
  });

  it('each page needs its switch on and equipment with a driver', () => {
    setup(equipped({ camera: true }));
    expect(fn()).toMatchObject({
      cameras: [{ id: 'ptz1', canMove: true }],
      microphones: [],
      lights: [],
      movers: [],
    });
    rt.dispose();
    sim.dispose();
    setup(equipped({ lights: true, blinds: true, microphones: true }));
    expect(fn()!.cameras).toEqual([]);
    expect(fn()!.lights.map((l) => l.name)).toEqual(['Room lights']);
    expect(fn()!.microphones.map((m) => m.name)).toEqual(['Lectern mic']);
    expect(fn()!.movers.map((m) => [m.kind, m.actions])).toEqual([
      ['blinds', ['open', 'close']],
      ['screen', ['down', 'up']],
    ]);
  });

  it('leaves out equipment that has no driver, and lights with no scenes', () => {
    const m = equipped();
    for (const id of ['ptz1', 'blinds1', 'mic1'])
      delete m.devices.find((d) => d.id === id)!.control;
    m.devices.find((d) => d.id === 'lights1')!.settings = {};
    setup(m);
    expect(fn()!.cameras).toEqual([]);
    expect(fn()!.lights).toEqual([]);
    expect(fn()!.microphones).toEqual([]);
    expect(fn()!.movers.map((x) => x.name)).toEqual(['Projection screen']);
  });

  it('offers presets and scenes the room’s own activities already use, as well as the device’s', () => {
    const m = equipped();
    m.activities[0]!.actions.push(
      { id: 'cam', type: 'camera_preset', deviceId: 'ptz1', preset: 'Lectern', dependsOn: [] },
      { id: 'sc', type: 'env_scene', deviceId: 'lights1', scene: 'Movie', dependsOn: [] },
    );
    setup(m);
    expect(fn()!.cameras[0]!.presets).toEqual(['Wide', 'Podium', 'Lectern']);
    expect(fn()!.lights[0]!.scenes).toEqual(['Bright', 'Dim', 'Movie']);
  });
});

describe('using the pages', () => {
  it('recalls a camera preset and shows which is active; refuses names it does not offer', async () => {
    setup(equipped());
    const send = vi.spyOn(sim, 'send');
    rt.dispatch({ type: 'camera.preset', deviceId: 'ptz1', preset: 'Nowhere' });
    rt.dispatch({ type: 'camera.preset', deviceId: 'nope', preset: 'Wide' });
    expect(send).not.toHaveBeenCalled();
    rt.dispatch({ type: 'camera.preset', deviceId: 'ptz1', preset: 'Podium' });
    await advance(2000);
    expect(fn()!.cameras[0]!.activePreset).toBe('Podium');
  });

  it('mutes and unmutes a microphone', async () => {
    setup(equipped());
    expect(fn()!.microphones[0]!.muted).toBe(false);
    rt.dispatch({ type: 'mic.mute', deviceId: 'mic1', muted: true });
    await advance(500);
    expect(fn()!.microphones[0]!.muted).toBe(true);
    rt.dispatch({ type: 'mic.mute', deviceId: 'mic1', muted: false });
    await advance(500);
    expect(fn()!.microphones[0]!.muted).toBe(false);
  });

  it('recalls a lighting scene, only ones on offer', async () => {
    setup(equipped());
    rt.dispatch({ type: 'scene.set', deviceId: 'lights1', scene: 'Disco' });
    await advance(1000);
    expect(fn()!.lights[0]!.active).toBeNull();
    rt.dispatch({ type: 'scene.set', deviceId: 'lights1', scene: 'Dim' });
    await advance(1000);
    expect(fn()!.lights[0]!.active).toBe('Dim');
  });

  it('moves blinds and screens with the words the driver understands, and only allowed ones', async () => {
    setup(equipped());
    const send = vi.spyOn(sim, 'send');
    rt.dispatch({ type: 'mover.run', deviceId: 'blinds1', action: 'open' });
    rt.dispatch({ type: 'mover.run', deviceId: 'screen1', action: 'down' });
    rt.dispatch({ type: 'mover.run', deviceId: 'blinds1', action: 'down' }); // blinds do not go "down"
    rt.dispatch({ type: 'mover.run', deviceId: 'nope', action: 'open' });
    await advance(500);
    expect(send.mock.calls.map(([id, c]) => [id, c])).toEqual([
      ['blinds1', { type: 'command', name: 'open', args: {} }],
      ['screen1', { type: 'command', name: 'down', args: {} }],
    ]);
  });
});

describe('moving a camera', () => {
  const moves = (send: { mock: { calls: unknown[][] } }) =>
    send.mock.calls
      .map(([, command]) => command as { type: string; pan: number; tilt: number; zoom: number })
      .filter((command) => command.type === 'camera_move');

  it('sends the move and the stop', async () => {
    setup(equipped());
    const send = vi.spyOn(sim, 'send');
    rt.dispatch({ type: 'camera.move', deviceId: 'ptz1', pan: -1, tilt: 0, zoom: 1 });
    rt.dispatch({ type: 'camera.move', deviceId: 'ptz1', pan: 0, tilt: 0, zoom: 0 });
    await advance(500);
    expect(moves(send)).toEqual([
      { type: 'camera_move', pan: -1, tilt: 0, zoom: 1 },
      { type: 'camera_move', pan: 0, tilt: 0, zoom: 0 },
    ]);
  });

  it('stops by itself if the panel stops asking, and keeps going while it is asked', async () => {
    setup(equipped());
    const send = vi.spyOn(sim, 'send');
    for (let i = 0; i < 4; i++) {
      rt.dispatch({ type: 'camera.move', deviceId: 'ptz1', pan: 1, tilt: 0, zoom: 0 });
      await advance(1000);
    }
    // Four seconds of held button: still no stop.
    expect(moves(send).filter((c) => c.pan === 0)).toHaveLength(0);
    await advance(2500);
    expect(moves(send).at(-1)).toEqual({ type: 'camera_move', pan: 0, tilt: 0, zoom: 0 });
  });

  it('stops when the room is suspended or shut down', async () => {
    setup(equipped());
    const send = vi.spyOn(sim, 'send');
    rt.dispatch({ type: 'camera.move', deviceId: 'ptz1', pan: 1, tilt: 1, zoom: 0 });
    rt.suspend();
    await advance(100);
    expect(moves(send).at(-1)).toEqual({ type: 'camera_move', pan: 0, tilt: 0, zoom: 0 });
  });

  it('ignores moves for a device that is not an offered camera', async () => {
    setup(equipped());
    const send = vi.spyOn(sim, 'send');
    rt.dispatch({ type: 'camera.move', deviceId: 'lights1', pan: 1, tilt: 0, zoom: 0 });
    rt.dispatch({ type: 'camera.move', deviceId: 'ptz1', pan: 5, tilt: 0, zoom: 0 } as never);
    await advance(500);
    expect(moves(send)).toEqual([]);
  });
});
