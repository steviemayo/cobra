import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomRuntime, validateRoomModel } from '@kestrel/engine';
import { RoomModel } from '@kestrel/model';
import { createSimulation, type Simulation } from './sim/simulation';

// A monitored room is just devices: no connections, states, activities or triggers.
const monitored = () =>
  RoomModel.parse({
    roomType: 'meeting',
    devices: [
      {
        id: 'dsp',
        name: 'DSP',
        category: 'audio_matrix',
        control: { kind: 'driver', driverId: 'qsys-core', settings: { host: '10.0.0.5' } },
      },
    ],
  });

let sim: Simulation | undefined;
let rt: RoomRuntime | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  rt?.dispose();
  sim?.dispose();
  rt = sim = undefined;
  vi.useRealTimers();
});

describe('a monitored room', () => {
  it('has no design errors, so it can be published and deployed', () => {
    expect(validateRoomModel(monitored()).issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('runs with nothing to offer on the panel, and does not fall over', () => {
    const model = monitored();
    sim = createSimulation(model);
    rt = new RoomRuntime({ model, roomName: 'Watched room', bus: sim });
    expect(rt!.getSnapshot().activities).toEqual([]);
  });
});
