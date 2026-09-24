'use client';
import { useEffect, useState } from 'react';
import { RoomRuntime } from '@kestrel/engine';
import { createSimulation, type Simulation } from '@kestrel/drivers';
import type { RoomModel } from '@kestrel/model';
import { describeChange } from '@/lib/sim-log';

export interface LogEntry {
  id: number;
  at: number;
  text: string;
  kind: 'device' | 'panel';
}

export interface SimulationInstance {
  sim: Simulation;
  runtime: RoomRuntime;
}

export const SPEEDS = [
  { value: '1', label: 'Real time', scale: 1 },
  { value: '0.25', label: '4× faster', scale: 0.25 },
  { value: '0', label: 'Instant', scale: 0 },
] as const;

/** Short idle/warning timers so auto-off can be watched in seconds instead of minutes. */
function withDemoTimers(model: RoomModel): RoomModel {
  return {
    ...model,
    settings: {
      ...model.settings,
      autoOff: { enabled: true, idleSeconds: 20, warnSeconds: 10 },
    },
  };
}

export function useSimulation(args: {
  model: RoomModel | null;
  roomName: string;
  speed: number;
  demoTimers: boolean;
  resetKey: number;
}) {
  const { model, roomName, speed, demoTimers, resetKey } = args;
  const [instance, setInstance] = useState<SimulationInstance | null>(null);
  const [version, setVersion] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);

  useEffect(() => {
    if (!model) {
      setInstance(null);
      return;
    }
    const runModel = demoTimers ? withDemoTimers(model) : model;
    const sim = createSimulation(runModel, { latencyScale: speed });
    const runtime = new RoomRuntime({ model: runModel, roomName, bus: sim });
    const devices = new Map(runModel.devices.map((d) => [d.id, d]));
    const previous = new Map(Object.entries(sim.allStates()));
    let nextId = 1;
    let lastMessage = runtime.getSnapshot().message?.text.key;

    const push = (entries: Omit<LogEntry, 'id' | 'at'>[]) => {
      if (entries.length === 0) return;
      setLog((l) =>
        [...entries.map((e) => ({ ...e, id: nextId++, at: Date.now() })).reverse(), ...l].slice(
          0,
          60,
        ),
      );
    };

    const offSim = sim.subscribe((event) => {
      const device = devices.get(event.deviceId);
      if (device)
        push(
          describeChange(device, previous.get(event.deviceId), event.state).map((text) => ({
            text,
            kind: 'device' as const,
          })),
        );
      previous.set(event.deviceId, event.state);
      setVersion((v) => v + 1);
    });
    const offRuntime = runtime.subscribe(() => {
      const key = runtime.getSnapshot().message?.text.key;
      if (key !== lastMessage) {
        lastMessage = key;
        if (key) push([{ text: `Panel says: ${key.replace(/_/g, ' ')}`, kind: 'panel' }]);
      }
      setVersion((v) => v + 1);
    });

    setInstance({ sim, runtime });
    setLog([]);
    return () => {
      offSim();
      offRuntime();
      runtime.dispose();
      sim.dispose();
    };
    // Speed is applied live by the effect below; only a new model or a reset needs a new instance.
  }, [model, roomName, demoTimers, resetKey]);

  useEffect(() => {
    instance?.sim.setLatencyScale(speed);
  }, [instance, speed]);

  return { instance, version, log };
}
