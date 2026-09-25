import { RoomRuntime, TriggerScheduler } from '@kestrel/engine';
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
  /** The device bus this room runs on. Exposed for diagnostics and the demo. */
  bus: DeviceBus;
  access: PanelAccess;
  branding: PanelBranding;
  /** Ids of this room's real devices that are unreachable right now. */
  offline(): string[];
  /** Starts anything that acts on its own (schedules). Called when the room goes live, not while staged. */
  begin(): void;
  close(): void;
}

interface BuiltBus {
  bus: DeviceBus;
  offline(): string[];
  close(): void;
}

/** Real drivers where the room configures them; simulated devices fill the gaps if allowed. */
export function buildBus(signed: SignedManifest, mode: SimulateMode, log: Logger): BuiltBus {
  const model = signed.manifest.model;
  if (mode === 'all') {
    const sim = createSimulation(model, { customDrivers: signed.manifest.drivers });
    return { bus: sim, offline: () => [], close: () => sim.dispose() };
  }
  const real = new Map<string, DeviceDriver>();
  for (const device of model.devices) {
    const driver = createDriver(
      device,
      { log: (l, m, x) => log(l, m, { device: device.name, ...x }) },
      signed.manifest.drivers,
    );
    if (driver) real.set(device.id, driver);
  }
  const bus = new HybridBus(
    real,
    mode === 'missing' ? createSimulation(model, { customDrivers: signed.manifest.drivers }) : null,
  );
  bus.start();
  return { bus, offline: () => bus.offline(), close: () => bus.close() };
}

/**
 * Runs one runtime per assigned room, each with its own device connections. A room that fails to
 * load or throws never takes the others down.
 */
export class RoomHost {
  private readonly rooms = new Map<string, LoadedRoom>();
  private readonly reloadListeners = new Set<(roomId: string) => void>();
  private combineListener: ((roomId: string, combined: boolean) => void) | null = null;

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

  /** Set by the combine coordinator: a room's panel asked to join or split its combination. */
  onCombineRequest(listener: (roomId: string, combined: boolean) => void) {
    this.combineListener = listener;
  }

  /** Build a room and start connecting to its devices without replacing the one that is running. */
  stage(signed: SignedManifest): LoadedRoom {
    const { manifest } = signed;
    const built = buildBus(signed, this.mode, this.log);
    const runtime = new RoomRuntime({
      model: manifest.model,
      roomName: manifest.roomName,
      bus: built.bus,
      onCombine: (combined) => this.combineListener?.(manifest.roomId, combined),
    });
    const scheduler = new TriggerScheduler(manifest.model, { fire: (t) => runtime.fire(t.run) });
    const room: LoadedRoom = {
      roomId: manifest.roomId,
      releaseId: manifest.releaseId,
      signed,
      runtime,
      bus: built.bus,
      access: manifest.panel.access,
      branding: manifest.panel.branding,
      offline: built.offline,
      begin: () => scheduler.start(),
      close: () => {
        scheduler.stop();
        runtime.dispose();
        built.close();
      },
    };
    return room;
  }

  /**
   * Wait for the staged room's devices to answer. Returns the names of devices that stayed
   * unreachable, ignoring any that were already unreachable in the room being replaced, so an
   * unrelated outage doesn't block a release that didn't cause it.
   */
  async healthCheck(staged: LoadedRoom, timeoutMs: number): Promise<string[]> {
    const alreadyDown = new Set(this.rooms.get(staged.roomId)?.offline() ?? []);
    const down = () => staged.offline().filter((id) => !alreadyDown.has(id));
    const deadline = Date.now() + timeoutMs;
    while (down().length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const names = new Map(staged.signed.manifest.model.devices.map((d) => [d.id, d.name]));
    return down().map((id) => names.get(id) ?? id);
  }

  /** Swap a staged room in for the running one. */
  activate(room: LoadedRoom): LoadedRoom {
    const { manifest } = room.signed;
    this.unload(room.roomId, false);
    this.watch(room);
    this.rooms.set(room.roomId, room);
    room.begin();
    this.log('info', 'Room loaded', {
      roomId: room.roomId,
      room: manifest.roomName,
      release: manifest.releaseNumber,
    });
    this.notify(room.roomId);
    return room;
  }

  load(signed: SignedManifest): LoadedRoom {
    return this.activate(this.stage(signed));
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
      manifestHash: r.signed.hash,
      status: r.runtime.getSnapshot().status,
      devices: r.signed.manifest.model.devices.map((d) => ({
        deviceId: d.id,
        name: d.name,
        online: r.bus.getState(d.id)?.online ?? true,
      })),
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
    // Tell the cloud when a device drops off or comes back, with the time it happened.
    const names = new Map(room.signed.manifest.model.devices.map((d) => [d.id, d.name]));
    const reachable = new Map<string, boolean>(
      [...names.keys()].map((id) => [id, room.bus.getState(id)?.online ?? true]),
    );
    const stopDevices = room.bus.subscribe(({ deviceId, state }) => {
      if (!names.has(deviceId) || reachable.get(deviceId) === state.online) return;
      reachable.set(deviceId, state.online);
      this.emit({
        at: at(),
        type: state.online ? 'device.online' : 'device.offline',
        roomId: room.roomId,
        data: { deviceId, name: names.get(deviceId) },
      });
    });
    const close = room.close;
    room.close = () => {
      stopDevices();
      close();
    };
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
      const now = new Set(
        vm.activities.filter((a) => a.active && a.kind !== 'room_off').map((a) => a.id),
      );
      for (const id of now)
        if (!active.has(id))
          this.emit({
            at: at(),
            type: 'activity.started',
            roomId: room.roomId,
            data: { activityId: id },
          });
      for (const id of active)
        if (!now.has(id))
          this.emit({
            at: at(),
            type: 'activity.stopped',
            roomId: room.roomId,
            data: { activityId: id },
          });
      active = now;
    });
  }
}
