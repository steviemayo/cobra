import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomRuntime } from '@kestrel/engine';
import { STARTER_TEMPLATES, type Device, type RoomModel } from '@kestrel/model';
import { createSimulation, type Simulation } from './sim/simulation';

// A room behaves the same whichever video destination category its screens use: the older
// video_destination, display, or projector.
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
let sim: Simulation;
let rt: RoomRuntime;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  rt.dispose();
  sim.dispose();
  vi.useRealTimers();
});

const isScreen = (d: Device) => d.id.startsWith('display');

for (const category of ['video_destination', 'display', 'projector'] as const) {
  describe(`screens as ${category}`, () => {
    it('powers on, shows the source and offers Blank Screen', async () => {
      const model: RoomModel = structuredClone(STARTER_TEMPLATES[0]!.model);
      for (const d of model.devices) if (isScreen(d)) d.category = category;
      sim = createSimulation(model);
      rt = new RoomRuntime({ model, roomName: 'Test room', bus: sim });
      rt.dispatch({ type: 'activity.start', activityId: 'present' });
      await advance(3000);
      const screens = model.devices.filter(isScreen);
      expect(screens.length).toBeGreaterThan(0);
      for (const d of screens) {
        expect(sim.getState(d.id)?.power, d.id).toBe('on');
        expect(sim.getState(d.id)?.selectedInput, d.id).toBeTruthy();
      }
      expect(rt.getSnapshot().quickActions?.map((a) => a.id)).toContain('display.blank');
    });
  });
}
