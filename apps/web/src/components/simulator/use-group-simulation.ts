'use client';
import { useEffect, useMemo, useState } from 'react';
import { GroupController, RoomRuntime } from '@kestrel/engine';
import { createSimulation, type Simulation } from '@kestrel/drivers';
import type {
  GroupConfig,
  PanelClient,
  PanelIntent,
  PanelViewModel,
  RoomModel,
} from '@kestrel/model';

export interface SimulatedGroupRoom {
  id: string;
  name: string;
  kind: 'standard' | 'combined';
  model: RoomModel | null;
  problem: string | null;
}

export interface GroupSimulationInput {
  config: GroupConfig;
  rooms: SimulatedGroupRoom[];
}

export interface RunningRoom {
  id: string;
  name: string;
  kind: 'standard' | 'combined';
  model: RoomModel;
  sim: Simulation;
  runtime: RoomRuntime;
}

/**
 * A panel standing in one room. It shows and controls whichever room is running that room's space
 * right now: the room itself, or the combined room while rooms are linked. Same idea as on a gateway.
 */
class FollowingPanel implements PanelClient {
  private readonly listeners = new Set<() => void>();
  private off: (() => void) | null = null;
  private current: RoomRuntime | null = null;
  private stopChanges: (() => void) | null = null;

  constructor(
    private readonly resolve: () => RoomRuntime,
    private readonly onChange: (listener: () => void) => () => void,
  ) {}

  getSnapshot(): PanelViewModel {
    return this.resolve().getSnapshot();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.bind();
      this.stopChanges = this.onChange(() => {
        this.bind();
        this.emit();
      });
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.off?.();
        this.off = null;
        this.current = null;
        this.stopChanges?.();
        this.stopChanges = null;
      }
    };
  }

  dispatch(intent: PanelIntent): void {
    this.resolve().dispatch(intent);
  }

  private bind() {
    const next = this.resolve();
    if (next === this.current) return;
    this.off?.();
    this.current = next;
    this.off = next.subscribe(() => this.emit());
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}

/**
 * Runs every room of a group in the browser, each against its own simulated equipment, with the
 * same `GroupController` the gateway uses, so linking and separating rooms can be tried out.
 */
export function useGroupSimulation(args: {
  data: GroupSimulationInput | undefined;
  speed: number;
  resetKey: number;
}) {
  const { data, speed, resetKey } = args;
  const [version, setVersion] = useState(0);
  const [built, setBuilt] = useState<{
    rooms: Map<string, RunningRoom>;
    controller: GroupController;
    changes: Set<() => void>;
  } | null>(null);

  useEffect(() => {
    if (!data) {
      setBuilt(null);
      return;
    }
    const rooms = new Map<string, RunningRoom>();
    const changes = new Set<() => void>();
    const bump = () => setVersion((v) => v + 1);
    // eslint-disable-next-line prefer-const -- the runtimes need it, and it needs the runtimes
    let controller: GroupController;
    for (const r of data.rooms) {
      if (!r.model) continue;
      const sim = createSimulation(r.model, { latencyScale: speed });
      const runtime = new RoomRuntime({
        model: r.model,
        roomName: r.name,
        bus: sim,
        onDivider: (id, open) => void controller.set(id, open),
      });
      rooms.set(r.id, { id: r.id, name: r.name, kind: r.kind, model: r.model, sim, runtime });
    }
    controller = new GroupController(
      {
        runtime: (id) => rooms.get(id)?.runtime,
        roomName: (id) => data.rooms.find((r) => r.id === id)?.name ?? 'A room',
        changed: () => {
          for (const l of changes) l();
          bump();
        },
        log: () => undefined,
      },
      [data.config],
    );
    controller.reconcile();
    const offs = [...rooms.values()].flatMap((r) => [
      r.runtime.subscribe(bump),
      r.sim.subscribe(bump),
    ]);
    setBuilt({ rooms, controller, changes });
    return () => {
      offs.forEach((off) => off());
      for (const r of rooms.values()) {
        r.runtime.dispose();
        r.sim.dispose();
      }
    };
    // Speed is applied live below; only new data or a reset needs new rooms.
  }, [data, resetKey]);

  useEffect(() => {
    for (const r of built?.rooms.values() ?? []) r.sim.setLatencyScale(speed);
  }, [built, speed]);

  /** A panel standing in `roomId`. */
  const panelFor = useMemo(
    () => (roomId: string) => {
      if (!built) return null;
      const own = built.rooms.get(roomId);
      if (!own) return null;
      return new FollowingPanel(
        () => built.rooms.get(built.controller.activeRoomId(roomId))?.runtime ?? own.runtime,
        (l) => {
          built.changes.add(l);
          return () => built.changes.delete(l);
        },
      );
    },
    [built],
  );

  return { built, version, panelFor };
}
