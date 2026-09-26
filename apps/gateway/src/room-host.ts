import { RoomRuntime, TriggerScheduler } from '@kestrel/engine';
import { createSimulation } from '@kestrel/drivers';
import { HybridBus, createDriver, type DeviceDriver } from '@kestrel/drivers/real';
import { applyBindings } from '@kestrel/model';
import type {
  DeviceBus,
  DeviceValues,
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
  /** The addresses and logins this room runs with, when its release keeps them apart. */
  bindings?: RoomBindings;
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

/** What a room's addresses and logins are, as verified by the gateway. */
export interface RoomBindings {
  version: number;
  devices: DeviceValues;
}

/** The manifest with the room's bindings laid over each device's settings. What actually runs. */
export function withBindings(signed: SignedManifest, bindings?: RoomBindings): SignedManifest {
  if (!bindings) return signed;
  const { manifest } = signed;
  return { ...signed, manifest: { ...manifest, model: applyBindings(manifest.model, bindings.devices) } };
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
  private dividerListener: ((dividerId: string, open: boolean) => void) | null = null;
  private resolveActive: (roomId: string) => string = (roomId) => roomId;
  private readonly activeListeners = new Set<() => void>();

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

  /** Set by the group coordinator: a panel asked to open or close a movable wall. */
  onDividerRequest(listener: (dividerId: string, open: boolean) => void) {
    this.dividerListener = listener;
  }

  /**
   * The room that is really running a panel's room right now. Usually the room itself; while a wall
   * is open it is the combined room that includes it. Set by the group coordinator.
   */
  setActiveResolver(resolve: (roomId: string) => string) {
    this.resolveActive = resolve;
  }

  active(roomId: string): LoadedRoom | undefined {
    return this.rooms.get(this.resolveActive(roomId)) ?? this.rooms.get(roomId);
  }

  /** Called when which room runs a panel's room may have changed, so panels can follow it. */
  onActiveChange(listener: () => void): () => void {
    this.activeListeners.add(listener);
    return () => this.activeListeners.delete(listener);
  }

  notifyActiveChange() {
    for (const l of this.activeListeners) l();
  }

  /** Build a room and start connecting to its devices without replacing the one that is running. */
  stage(signed: SignedManifest, bindings?: RoomBindings): LoadedRoom {
    const { manifest } = signed;
    // `signed` stays as verified (its hash is what is reported); the merged copy is what runs.
    const running = withBindings(signed, bindings);
    const built = buildBus(running, this.mode, this.log);
    const runtime = new RoomRuntime({
      model: running.manifest.model,
      roomName: manifest.roomName,
      bus: built.bus,
      onDivider: (dividerId, open) => this.dividerListener?.(dividerId, open),
    });
    const scheduler = new TriggerScheduler(manifest.model, { fire: (t) => runtime.fire(t.run) });
    const room: LoadedRoom = {
      roomId: manifest.roomId,
      releaseId: manifest.releaseId,
      signed,
      ...(bindings ? { bindings } : {}),
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

  load(signed: SignedManifest, bindings?: RoomBindings): LoadedRoom {
    return this.activate(this.stage(signed, bindings));
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
      ...(r.bindings ? { bindingsVersion: r.bindings.version } : {}),
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
