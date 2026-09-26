import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomRuntime } from '@kestrel/engine';
import { STARTER_TEMPLATES, isVideoDestination, type RoomModel } from '@kestrel/model';
import { createSimulation, type Simulation } from './sim/simulation';

const meeting = (): RoomModel => structuredClone(STARTER_TEMPLATES[0]!.model);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

let sim: Simulation;
let rt: RoomRuntime;
const setup = (model: RoomModel) => {
  sim = createSimulation(model);
  rt = new RoomRuntime({ model, roomName: 'Test room', bus: sim });
};
const snap = () => rt.getSnapshot();

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  rt.dispose();
  sim.dispose();
  vi.useRealTimers();
});

// The starter room's displays speak PJLink, so it offers Blank Screen. `bare` is the same room with
// no driver on its displays, so nothing is offered.
const withBlankableDisplays = meeting;
const bare = (): RoomModel => {
  const m = meeting();
  for (const d of m.devices) if (isVideoDestination(d.category)) d.control = undefined;
  return m;
};
const withConferencing = (mic = true, base: () => RoomModel = bare) => {
  const m = base();
  m.devices.push({
    id: 'codec',
    name: 'Codec',
    category: 'conference_system',
    ports: [],
    extraCapabilities: [],
    control: { kind: 'driver', driverId: 'lib:cisco-roomos' },
    settings: {},
  });
  if (mic)
    m.devices.push({
      id: 'mic1',
      name: 'Ceiling mic',
      category: 'voice_capture_mic',
      ports: [],
      extraCapabilities: [],
      settings: {},
    });
  return m;
};
const quick = () => snap().quickActions?.map((a) => a.id) ?? [];
const startRoom = async () => {
  rt.dispatch({ type: 'activity.start', activityId: 'present' });
  await advance(3000);
};

describe('quick actions', () => {
  it('offers none when no driver in the room declares one', () => {
    setup(bare());
    expect(snap().quickActions).toBeUndefined();
  });

  it('offers Blank Screen when the room has displays whose driver supports it', () => {
    setup(withBlankableDisplays());
    expect(snap().quickActions).toEqual([
      { id: 'display.blank', label: 'Blank Screen', icon: 'blank', kind: 'toggle', active: false },
    ]);
  });

  it('one Blank Screen button acts on every display, and shows on only when all are blanked', async () => {
    setup(withBlankableDisplays());
    await startRoom();
    rt.dispatch({ type: 'quickaction.run', id: 'display.blank', active: true });
    await advance(500);
    expect(sim.getState('display1')!.blanked).toBe(true);
    expect(sim.getState('display2')!.blanked).toBe(true);
    expect(snap().quickActions![0]!.active).toBe(true);
    rt.dispatch({ type: 'quickaction.run', id: 'display.blank', active: false });
    await advance(500);
    expect(sim.getState('display1')!.blanked).toBe(false);
    expect(snap().quickActions![0]!.active).toBe(false);
  });

  it('without an explicit state it flips the current one', async () => {
    setup(withBlankableDisplays());
    await startRoom();
    rt.dispatch({ type: 'quickaction.run', id: 'display.blank' });
    await advance(500);
    expect(snap().quickActions![0]!.active).toBe(true);
    rt.dispatch({ type: 'quickaction.run', id: 'display.blank' });
    await advance(500);
    expect(snap().quickActions![0]!.active).toBe(false);
  });

  it('a display that is off refuses to blank, and the button stays off', async () => {
    setup(withBlankableDisplays());
    rt.dispatch({ type: 'quickaction.run', id: 'display.blank', active: true });
    await advance(500);
    expect(sim.getState('display1')!.blanked).toBe(false);
    expect(snap().quickActions![0]!.active).toBe(false);
  });

  it('turning the room off clears the blank', async () => {
    setup(withBlankableDisplays());
    await startRoom();
    rt.dispatch({ type: 'quickaction.run', id: 'display.blank', active: true });
    await advance(500);
    rt.dispatch({ type: 'activity.start', activityId: 'room_off' });
    await advance(3000);
    expect(sim.getState('display1')!.blanked).toBe(false);
  });

  it('ignores an id the room does not offer', async () => {
    setup(bare());
    const send = vi.spyOn(sim, 'send');
    rt.dispatch({ type: 'quickaction.run', id: 'display.blank', active: true });
    await advance(500);
    expect(send).not.toHaveBeenCalled();
  });

  it('offers Privacy Mute only with conferencing microphones and a conference system that can mute', async () => {
    setup(withConferencing());
    expect(quick()).toEqual(['mics.privacy_mute']);
    rt.dispatch({ type: 'quickaction.run', id: 'mics.privacy_mute', active: true });
    await advance(500);
    expect(sim.getState('codec')!.muted).toBe(true);
    expect(snap().quickActions![0]!.active).toBe(true);
  });

  it("leaves the room's own speaker mute alone", async () => {
    setup(withConferencing());
    const before = sim.getState('dsp')!.muted;
    rt.dispatch({ type: 'quickaction.run', id: 'mics.privacy_mute', active: true });
    await advance(500);
    expect(sim.getState('dsp')!.muted).toBe(before);
  });

  it('does not offer Privacy Mute without microphones, or without a conference system', () => {
    setup(withConferencing(false));
    expect(quick()).toEqual([]);
    rt.dispose();
    sim.dispose();
    setup(bare());
    expect(quick()).toEqual([]);
  });

  it('does not offer Privacy Mute when the conference system has no driver for it', () => {
    const m = withConferencing();
    m.devices.find((d) => d.id === 'codec')!.control = undefined;
    setup(m);
    expect(quick()).toEqual([]);
  });

  it('offers both, in a fixed order', () => {
    setup(withConferencing(true, meeting));
    expect(quick()).toEqual(['display.blank', 'mics.privacy_mute']);
  });
});
