import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STARTER_TEMPLATES, type DeviceEvent, type RoomModel } from '@kestrel/model';
import { createSimulation, type Simulation } from './simulation';

const meeting = (): RoomModel => structuredClone(STARTER_TEMPLATES[0]!.model);
const training = (): RoomModel =>
  structuredClone(STARTER_TEMPLATES.find((t) => t.id === 'training-recorded')!.model);

describe('Simulation', () => {
  let sim: Simulation;
  beforeEach(() => {
    vi.useFakeTimers();
    sim = createSimulation(meeting());
  });
  afterEach(() => {
    sim.dispose();
    vi.useRealTimers();
  });

  it('starts with everything off, unrouted and muted', () => {
    expect(sim.getState('display1')).toMatchObject({ power: 'off', selectedInput: null });
    expect(sim.getState('matrix')!.routes).toEqual({ out1: null, out2: null, out3: null });
    expect(sim.getState('dsp')).toMatchObject({ muted: true, volume: 50 });
  });

  it('displays take time to warm up and only report ready when on', async () => {
    const done = sim.send('display1', { type: 'power', on: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(sim.getState('display1')!.power).toBe('warming');
    await vi.advanceTimersByTimeAsync(2500);
    await done;
    expect(sim.getState('display1')!.power).toBe('on');
  });

  it('rejects an input change while the display is not on, so plans must order power first', async () => {
    await expect(sim.send('display1', { type: 'select_input', portId: 'in' })).rejects.toThrow(
      "Display 1 isn't on yet",
    );
  });

  it('rejects commands a device cannot handle', async () => {
    await expect(sim.send('speakers', { type: 'power', on: true })).rejects.toThrow(
      "Speakers doesn't support power",
    );
    await expect(
      sim.send('matrix', { type: 'route', inputPortId: 'nope', outputPortId: 'out1' }),
    ).rejects.toThrow();
  });

  it('routes on the matrix and reports it', async () => {
    const p = sim.send('matrix', { type: 'route', inputPortId: 'in2', outputPortId: 'out1' });
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(sim.getState('matrix')!.routes.out1).toBe('in2');
  });

  it('applies DSP mute, volume and preset', async () => {
    const all = Promise.all([
      sim.send('dsp', { type: 'mute', muted: false }),
      sim.send('dsp', { type: 'volume', level: 70 }),
      sim.send('dsp', { type: 'preset', name: 'Presentation' }),
    ]);
    await vi.advanceTimersByTimeAsync(200);
    await all;
    expect(sim.getState('dsp')).toMatchObject({ muted: false, volume: 70, preset: 'Presentation' });
  });

  describe('signal', () => {
    it('shows a plugged-in laptop on the matrix input, and tells subscribers', () => {
      const events: DeviceEvent[] = [];
      sim.subscribe((e) => events.push(e));
      sim.plug('laptop1', true);
      expect(sim.getState('matrix')!.signal).toEqual({ in1: true, in2: false });
      expect(events.at(-1)).toMatchObject({ deviceId: 'matrix' });
      sim.plug('laptop1', false);
      expect(sim.getState('matrix')!.signal.in1).toBe(false);
    });

    it('only reaches a display once the matrix routes it there', async () => {
      sim.plug('laptop1', true);
      expect(sim.getState('display1')!.signal.in).toBe(false);
      const p = sim.send('matrix', { type: 'route', inputPortId: 'in1', outputPortId: 'out1' });
      await vi.advanceTimersByTimeAsync(200);
      await p;
      expect(sim.getState('display1')!.signal.in).toBe(true);
      expect(sim.getState('display2')!.signal.in).toBe(false);
      expect([...sim.flow()].sort()).toEqual(['c1', 'c3']);
    });

    it('carries audio through the matrix and DSP to the speakers', async () => {
      sim.plug('laptop2', true);
      const p = sim.send('matrix', { type: 'route', inputPortId: 'in2', outputPortId: 'out3' });
      await vi.advanceTimersByTimeAsync(200);
      await p;
      expect(sim.flow().has('c6')).toBe(true);
      expect(sim.flow().has('c5')).toBe(true);
    });

    it('cannot plug something that is not a laptop', () => {
      expect(() => sim.plug('display1', true)).toThrow();
    });
  });

  describe('faults', () => {
    it('an offline device rejects commands and reports offline', async () => {
      sim.setFault('display2', { offline: true });
      expect(sim.getState('display2')!.online).toBe(false);
      await expect(sim.send('display2', { type: 'power', on: true })).rejects.toThrow(
        'Display 2 is offline',
      );
      sim.setFault('display2', null);
      expect(sim.getState('display2')!.online).toBe(true);
    });

    it('rejectCommands fails commands but stays online', async () => {
      sim.setFault('dsp', { rejectCommands: true });
      await expect(sim.send('dsp', { type: 'mute', muted: false })).rejects.toThrow(
        'DSP did not respond',
      );
      expect(sim.getState('dsp')!.online).toBe(true);
    });

    it('a device that drops offline mid-command fails it', async () => {
      const p = sim.send('display1', { type: 'power', on: true }).catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(500);
      sim.setFault('display1', { offline: true });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await p).toBe('Display 1 is offline');
    });
  });

  it('a training room camera is always sending, so the recorder can be fed without a laptop', async () => {
    const t = createSimulation(training(), { latencyScale: 0 });
    await t.send('matrix', { type: 'route', inputPortId: 'in3', outputPortId: 'out4' });
    expect(t.flow().has('c8')).toBe(true);
    await t.send('recorder', { type: 'record', on: true });
    expect(t.getState('recorder')!.recording).toBe(true);
    await t.send('camera', { type: 'camera_preset', name: 'lectern' });
    expect(t.getState('camera')!.preset).toBe('lectern');
    t.dispose();
  });

  it('latencyScale 0 makes everything instant', async () => {
    const fast = createSimulation(meeting(), { latencyScale: 0 });
    await fast.send('display1', { type: 'power', on: true });
    expect(fast.getState('display1')!.power).toBe('on');
    fast.dispose();
  });
});
