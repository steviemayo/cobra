import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomRuntime, validateRoomModel } from '@kestrel/engine';
import { STARTER_TEMPLATES, checkDriverSpec, type Device, type PinnedDriver, type RoomModel } from '@kestrel/model';
import { createSimulation, type Simulation } from './sim/simulation';

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

// A wireless microphone system that can mute and set a level.
const spec = (() => {
  const checked = checkDriverSpec({
    id: 'wireless-mic',
    name: 'Wireless mic',
    class: 'reinforcement_mic',
    features: ['mute', 'volume'],
    transport: { type: 'http' },
    commands: { 'mute.on': { path: '/m/1' }, 'mute.off': { path: '/m/0' }, volume: { path: '/v/{level}' } },
  });
  if (!checked.ok) throw new Error(checked.problems.join('; '));
  return checked.spec;
})();
const ceilingSpec = (() => {
  const checked = checkDriverSpec({
    id: 'ceiling-mic',
    name: 'Ceiling mic',
    class: 'conferencing_mic',
    features: ['privacy_mute'],
    transport: { type: 'http' },
    commands: { 'mute.on': { path: '/m/1' }, 'mute.off': { path: '/m/0' } },
  });
  if (!checked.ok) throw new Error(checked.problems.join('; '));
  return checked.spec;
})();
const custom: Record<string, PinnedDriver> = {
  'custom:wireless-mic': { version: 1, spec },
  'custom:ceiling-mic': { version: 1, spec: ceilingSpec },
};
const driven = { kind: 'driver', driverId: 'custom:wireless-mic' } as const;

const mic = (id: string, name: string, extra: Partial<Device> = {}): Device => ({
  id,
  name,
  category: 'reinforcement_mic',
  ports: [],
  extraCapabilities: [],
  settings: {},
  control: driven,
  ...extra,
});

function room(devices: Device[]): RoomModel {
  const m = structuredClone(STARTER_TEMPLATES[0]!.model);
  m.settings.userControls.microphones = true;
  m.devices.push(...devices);
  return m;
}

let sim: Simulation;
let rt: RoomRuntime;
const setup = (model: RoomModel) => {
  sim = createSimulation(model, { customDrivers: custom });
  rt = new RoomRuntime({ model, roomName: 'Test room', bus: sim });
};
const mics = () => rt.getSnapshot().functions?.microphones ?? [];
const present = (m: RoomModel) => m.activities.find((a) => a.kind === 'present')!;
const roomOff = (m: RoomModel) => m.activities.find((a) => a.kind === 'room_off')!;
const state = (id: string) => sim.getState(id)!;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  rt.dispose();
  sim.dispose();
  vi.useRealTimers();
});

describe('the microphones page', () => {
  it('lists reinforcement microphones by label and order, and leaves out hidden ones', () => {
    setup(
      room([
        mic('a', 'Handheld A', { mic: { order: 2 } }),
        mic('b', 'Radio B', { mic: { label: 'Lectern mic', order: 1 } }),
        mic('c', 'Spare', { mic: { hidden: true } }),
        mic('d', 'Unordered'),
      ]),
    );
    expect(mics().map((m) => m.name)).toEqual(['Lectern mic', 'Handheld A', 'Unordered']);
  });

  it('never lists a conferencing microphone', () => {
    setup(room([mic('cm', 'Ceiling mic', { category: 'voice_capture_mic' })]));
    expect(rt.getSnapshot().functions).toBeUndefined();
  });

  it('offers volume only when the driver declares it, and shows the level only when reported', () => {
    setup(room([mic('a', 'With volume'), mic('b', 'Without', { control: { kind: 'generic', protocol: 'tcp' } })]));
    expect(mics().map((m) => [m.canVolume, m.volume])).toEqual([
      [true, 50],
      [false, null],
    ]);
  });

  it('nudges the volume from where it is, within 0 to 100, and ignores a mic with no volume', async () => {
    setup(room([mic('a', 'With volume'), mic('b', 'Without', { control: { kind: 'generic', protocol: 'tcp' } })]));
    rt.dispatch({ type: 'mic.bump', deviceId: 'a', delta: 10 });
    await advance(1000);
    expect(state('a').volume).toBe(60);
    rt.dispatch({ type: 'mic.bump', deviceId: 'a', delta: 25 });
    await advance(1000);
    rt.dispatch({ type: 'mic.bump', deviceId: 'a', delta: 25 });
    await advance(1000);
    rt.dispatch({ type: 'mic.bump', deviceId: 'a', delta: 25 });
    await advance(1000);
    expect(state('a').volume).toBe(100);
    const spy = vi.spyOn(sim, 'send');
    rt.dispatch({ type: 'mic.bump', deviceId: 'b', delta: 10 });
    await advance(1000);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('with the room', () => {
  it('unmutes when the room turns on and mutes when it turns off, by default', async () => {
    const m = room([mic('a', 'Lectern')]);
    setup(m);
    void sim.send('a', { type: 'mute', muted: true });
    await advance(1000);
    rt.dispatch({ type: 'activity.start', activityId: present(m).id });
    await advance(30_000);
    expect(state('a').muted).toBe(false);
    rt.dispatch({ type: 'activity.start', activityId: roomOff(m).id });
    await advance(30_000);
    expect(state('a').muted).toBe(true);
  });

  it('follows each microphone setting: leave alone, or mute on start', async () => {
    const m = room([
      mic('keep', 'Kept', { mic: { onStart: 'leave', onStop: 'leave' } }),
      mic('quiet', 'Quiet', { mic: { onStart: 'mute' } }),
    ]);
    setup(m);
    void sim.send('keep', { type: 'mute', muted: true });
    await advance(1000);
    rt.dispatch({ type: 'activity.start', activityId: present(m).id });
    await advance(30_000);
    expect(state('keep').muted).toBe(true);
    expect(state('quiet').muted).toBe(true);
    void sim.send('keep', { type: 'mute', muted: false });
    await advance(1000);
    rt.dispatch({ type: 'activity.start', activityId: roomOff(m).id });
    await advance(30_000);
    expect(state('keep').muted).toBe(false);
  });

  it('an activity can override a microphone for its own run', async () => {
    const m = room([mic('a', 'Lectern')]);
    const call = present(m);
    call.micOverrides = { a: 'mute' };
    setup(m);
    rt.dispatch({ type: 'activity.start', activityId: call.id });
    await advance(30_000);
    expect(state('a').muted).toBe(true);
  });

  it('changing activity while on does not reset a microphone someone muted', async () => {
    const m = room([mic('a', 'Lectern')]);
    setup(m);
    rt.dispatch({ type: 'activity.start', activityId: present(m).id });
    await advance(30_000);
    rt.dispatch({ type: 'mic.mute', deviceId: 'a', muted: true });
    await advance(1000);
    rt.dispatch({ type: 'activity.start', activityId: present(m).id });
    await advance(30_000);
    expect(state('a').muted).toBe(true);
  });

  it('a room restored after a combined room leaves its microphones as they are', async () => {
    const m = room([mic('a', 'Lectern')]);
    setup(m);
    rt.dispatch({ type: 'activity.start', activityId: present(m).id });
    await advance(30_000);
    const parked = rt.suspend();
    void sim.send('a', { type: 'mute', muted: true });
    await advance(1000);
    rt.resume();
    const done = rt.restore(parked);
    await advance(30_000);
    await done;
    expect(state('a').muted).toBe(true);
  });

  it('a microphone that will not answer does not stop the room starting', async () => {
    const m = room([mic('a', 'Lectern')]);
    setup(m);
    sim.setFault('a', { offline: true });
    rt.dispatch({ type: 'activity.start', activityId: present(m).id });
    await advance(30_000);
    expect(rt.getSnapshot().status).toBe('on');
  });
});

describe('a conferencing microphone', () => {
  it('warns when it is wired to the room speakers', () => {
    const m = room([
      {
        ...mic('cm', 'Ceiling mic', { category: 'voice_capture_mic' }),
        ports: [{ id: 'out', name: 'Out', direction: 'out', signal: 'audio' }],
      },
      {
        id: 'spk',
        name: 'Ceiling speakers',
        category: 'audio_destination',
        ports: [{ id: 'in', name: 'In', direction: 'in', signal: 'audio' }],
        extraCapabilities: [],
        settings: {},
      },
    ]);
    m.connections.push({ id: 'c1', from: { deviceId: 'cm', portId: 'out' }, to: { deviceId: 'spk', portId: 'in' } });
    const warn = validateRoomModel(m).issues.filter((i) => i.message.includes('conferencing microphone'));
    expect(warn.map((i) => i.severity)).toEqual(['warning']);
  });
});

describe('Privacy Mute', () => {
  const ceiling = (id: string, muteable = true) =>
    mic(id, 'Ceiling ' + id, {
      category: 'voice_capture_mic',
      control: muteable ? { kind: 'driver', driverId: 'custom:ceiling-mic' } : { kind: 'generic', protocol: 'tcp' },
    });
  const quick = () => (rt.getSnapshot().quickActions ?? []).filter((q) => q.id === 'mics.privacy_mute').map((q) => [q.id, q.active]);

  it('is offered when a conferencing microphone can mute itself, with no conference system', () => {
    setup(room([ceiling('c1')]));
    expect(quick()).toEqual([['mics.privacy_mute', false]]);
  });

  it('is not offered when no microphone can mute and there is no conference system that can', () => {
    setup(room([ceiling('c1', false)]));
    expect(quick()).toEqual([]);
  });

  it('mutes every microphone that supports it, and shows the combined state', async () => {
    setup(room([ceiling('c1'), ceiling('c2')]));
    rt.dispatch({ type: 'quickaction.run', id: 'mics.privacy_mute', active: true });
    await advance(2000);
    expect(state('c1').muted).toBe(true);
    expect(state('c2').muted).toBe(true);
    expect(quick()).toEqual([['mics.privacy_mute', true]]);
    void sim.send('c2', { type: 'mute', muted: false });
    await advance(1000);
    expect(quick()).toEqual([['mics.privacy_mute', false]]);
  });
});
