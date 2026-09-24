import { RoomRuntime } from '@kestrel/engine';
import { createSimulation } from '@kestrel/drivers';
import { HybridBus, createDriver, type DeviceDriver } from '@kestrel/drivers/real';
import type {
  DeviceBus,
  PanelAccess,
  PanelBranding,
  RoomReport,
  SignedManifest,
  TelemetryEvent,
} from '@kestrel/model';
import type { Logger } from './log';

export type SimulateMode = 'off' | 'all' | 'missing';

export interface LoadedRoom {
  roomId: string;
  releaseId: string;
  signed: SignedManifest;
  runtime: RoomRuntime;
  access: PanelAccess;
  branding: PanelBranding;
  close(): void;
}

interface BuiltBus {
  bus: DeviceBus;
  close(): void;
}

/** Real drivers where the room configures them; simulated devices fill the gaps if allowed. */
export function buildBus(signed: SignedManifest, mode: SimulateMode, log: Logger): BuiltBus {
  const model = signed.manifest.model;
  if (mode === 'all') {
    const sim = createSimulation(model);
    return { bus: sim, close: () => sim.dispose() };
  }
  const real = new Map<string, DeviceDriver>();
  for (const device of model.devices) {
    const driver = createDriver(device, { log: (l, m, x) => log(l, m, { device: device.name, ...x }) });
    if (driver) real.set(device.id, driver);
  }
  const bus = new HybridBus(real, mode === 'missing' ? createSimulation(model) : null);
  bus.start();
  return { bus, close: () => bus.close() };
}

/**
 * Runs one runtime per assigned room, each with its own device connections. A room that fails to
 * load or throws never takes the others down.
 */
export class RoomHost {
  private readonly rooms = new Map<string, LoadedRoom>();
  private readonly reloadListeners = new Set<(roomId: string) => void>();

  constructor(
    private readonly mode: SimulateMode,
    private readonly log: Logger,
    private readonly emit: (event: TelemetryEvent) => void,
  ) {}

  get(roomId: string): LoadedRoom | undefined {
    return this.rooms.get(roomId);
  }

  releaseOf(roomId: string): string | null {
    return this.rooms.get(roomId)?.releaseId ?? null;
  }

  ids(): string[] {
    return [...this.rooms.keys()];
  }

  /** Called when a room's runtime is replaced or removed, so panels can reconnect. */
  onReload(listener: (roomId: string) => void): () => void {
    this.reloadListeners.add(listener);
    return () => this.reloadListeners.delete(listener);
  }

  load(signed: SignedManifest): LoadedRoom {
    const { manifest } = signed;
    this.unload(manifest.roomId, false);
    const built = buildBus(signed, this.mode, this.log);
    const runtime = new RoomRuntime({
      model: manifest.model,
      roomName: manifest.roomName,
      bus: built.bus,
    });
    const room: LoadedRoom = {
      roomId: manifest.roomId,
      releaseId: manifest.releaseId,
      signed,
      runtime,
      access: manifest.panel.access,
      branding: manifest.panel.branding,
      close: () => {
        runtime.dispose();
        built.close();
      },
    };
    this.watch(room);
    this.rooms.set(room.roomId, room);
    this.log('info', 'Room loaded', {
      roomId: room.roomId,
      room: manifest.roomName,
      release: manifest.releaseNumber,
    });
    this.notify(room.roomId);
    return room;
  }

  unload(roomId: string, notify = true) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.close();
    this.rooms.delete(roomId);
    this.log('info', 'Room unloaded', { roomId });
    if (notify) this.notify(roomId);
  }

  reports(): RoomReport[] {
    return [...this.rooms.values()].map((r) => ({
      roomId: r.roomId,
      releaseId: r.releaseId,
      status: r.runtime.getSnapshot().status,
    }));
  }

  shutdown() {
    for (const id of this.ids()) this.unload(id, false);
  }

  private notify(roomId: string) {
    for (const l of this.reloadListeners) l(roomId);
  }

  // Turn runtime changes into telemetry events.
  private watch(room: LoadedRoom) {
    const at = () => new Date().toISOString();
    let status = room.runtime.getSnapshot().status;
    let active = new Set(
      room.runtime
        .getSnapshot()
        .activities.filter((a) => a.active && a.kind !== 'room_off')
        .map((a) => a.id),
    );
    room.runtime.subscribe(() => {
      const vm = room.runtime.getSnapshot();
      if (vm.status !== status) {
        status = vm.status;
        this.emit({ at: at(), type: 'room.status', roomId: room.roomId, data: { status } });
        if (status === 'fault')
          this.emit({
            at: at(),
            type: 'device.fault',
            roomId: room.roomId,
            data: { message: vm.message?.text.key ?? 'fault', ...(vm.message?.text.params ?? {}) },
          });
      }
      const now = new Set(vm.activities.filter((a) => a.active && a.kind !== 'room_off').map((a) => a.id));
      for (const id of now)
        if (!active.has(id))
          this.emit({ at: at(), type: 'activity.started', roomId: room.roomId, data: { activityId: id } });
      for (const id of active)
        if (!now.has(id))
          this.emit({ at: at(), type: 'activity.stopped', roomId: room.roomId, data: { activityId: id } });
      active = now;
    });
  }
}
