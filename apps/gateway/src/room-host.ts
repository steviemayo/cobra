import { RoomRuntime, TriggerScheduler } from '@kestrel/engine';
import { createSimulation } from '@kestrel/drivers';
import {
  HybridBus,
  attachVirtualDrivers,
  createDriver,
  type DeviceDriver,
} from '@kestrel/drivers/real';
import { applyBindings, checkWatch, type DeviceFeedback } from '@kestrel/model';
import type {
  DeviceBus,
  DeviceCommand,
  DeviceEvent,
  DeviceState,
  DeviceValues,
  PanelAccess,
  PanelBranding,
  Port,
  RoomReport,
  SignedManifest,
  TelemetryEvent,
} from '@kestrel/model';
import type { Logger } from './log';
import { occupancyTracker } from './occupancy';
import { SharedDevices } from './shared-devices';

/** Why a command was refused when the plan does not include control. */
export const CONTROL_NOT_LICENSED = 'Control is not included in this organisation’s plan';

/**
 * A room's bus with every command refused while control is off. Feedback, health and reads still
 * flow, so the room keeps being watched. Every route that acts on a device (panel, portal, trigger,
 * schedule, webhook) ends in `send`, so this is the one place that has to hold.
 */
export class ControlGate implements DeviceBus {
  readonly readPoint?: DeviceBus['readPoint'];

  constructor(
    private readonly inner: DeviceBus,
    private readonly allowed: () => boolean,
  ) {
    this.readPoint = inner.readPoint?.bind(inner);
  }

  send(deviceId: string, command: DeviceCommand): Promise<void> {
    if (!this.allowed()) return Promise.reject(new Error(CONTROL_NOT_LICENSED));
    return this.inner.send(deviceId, command);
  }

  getState(deviceId: string): DeviceState | undefined {
    return this.inner.getState(deviceId);
  }

  subscribe(listener: (event: DeviceEvent) => void): () => void {
    return this.inner.subscribe(listener);
  }

  quickActions(deviceId: string) {
    return this.inner.quickActions?.(deviceId) ?? [];
  }

  features(deviceId: string) {
    return this.inner.features?.(deviceId) ?? [];
  }
}

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
  /** Devices that are a slice of a shared site device, by device id. */
  sharedDevices?: Record<string, { siteDeviceId: string; exclusive: boolean }>;
}

/** The manifest with the room's bindings laid over each device's settings. What actually runs. */
export function withBindings(signed: SignedManifest, bindings?: RoomBindings): SignedManifest {
  if (!bindings) return signed;
  const { manifest } = signed;
  return {
    ...signed,
    manifest: { ...manifest, model: applyBindings(manifest.model, bindings.devices) },
  };
}

/**
 * Whatever the driver reports back for one device, in the shape the cloud stores: an input's port
 * id resolved to its name, and every other field carried over as is. Control or not, since none of
 * this is a command — it is what `reports()` sends up alongside `online`.
 */
export function deviceFeedback(state: DeviceState | undefined, ports: Port[]): DeviceFeedback {
  const feedback: DeviceFeedback = {};
  if (state?.power) feedback.power = state.power;
  if (state?.selectedInput) {
    const port = ports.find((p) => p.id === state.selectedInput);
    if (port) feedback.input = port.name;
  }
  if (state?.muted !== undefined) feedback.muted = state.muted;
  if (state?.volume !== undefined) feedback.volume = state.volume;
  if (state?.blanked !== undefined) feedback.blanked = state.blanked;
  if (state?.recording !== undefined) feedback.recording = state.recording;
  if (state?.occupied !== undefined) feedback.occupied = state.occupied;
  if (state?.streamConnected !== undefined) feedback.streamConnected = state.streamConnected;
  if (state?.activeApp !== undefined) feedback.activeApp = state.activeApp;
  return feedback;
}

/** Real drivers where the room configures them; simulated devices fill the gaps if allowed. */
export function buildBus(
  signed: SignedManifest,
  mode: SimulateMode,
  log: Logger,
  /** Shared site devices: one connection for every room that uses one. Absent: each room has its own. */
  sharing?: { shared: SharedDevices; devices: NonNullable<RoomBindings['sharedDevices']> },
): BuiltBus {
  const model = signed.manifest.model;
  if (mode === 'all') {
    const sim = createSimulation(model, { customDrivers: signed.manifest.drivers });
    return { bus: sim, offline: () => [], close: () => sim.dispose() };
  }
  const real = new Map<string, DeviceDriver>();
  const make = (device: (typeof model.devices)[number]) =>
    createDriver(
      device,
      { log: (l, m, x) => log(l, m, { device: device.name, ...x }) },
      signed.manifest.drivers,
    );
  for (const device of model.devices) {
    const shared = sharing?.devices[device.id];
    const driver = shared
      ? sharing!.shared.attach({
          siteDeviceId: shared.siteDeviceId,
          exclusive: shared.exclusive,
          roomId: signed.manifest.roomId,
          roomName: signed.manifest.roomName,
          device,
          build: make,
        })
      : make(device);
    if (driver) real.set(device.id, driver);
  }
  // The virtual switcher of an AVoIP system is logic over the other devices, so it is built last.
  attachVirtualDrivers(model, real, { log: (l, m, x) => log(l, m, x) });
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
  /** One connection per shared site device, whatever number of rooms use it. */
  readonly shared: SharedDevices;
  private controlOn = true;

  constructor(
    private readonly mode: SimulateMode,
    private readonly log: Logger,
    private readonly emit: (event: TelemetryEvent) => void,
  ) {
    this.shared = new SharedDevices(log);
  }

  /** Whether commands are accepted. The cloud says so on every heartbeat, from the organisation's plan. */
  get control(): boolean {
    return this.controlOn;
  }

  setControl(on: boolean) {
    if (on === this.controlOn) return;
    this.controlOn = on;
    this.log('info', on ? 'Control switched on' : 'Control switched off: commands are refused');
  }

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
    const sharing =
      bindings?.sharedDevices && Object.keys(bindings.sharedDevices).length > 0
        ? { shared: this.shared, devices: bindings.sharedDevices }
        : undefined;
    const built = buildBus(running, this.mode, this.log, sharing);
    const runtime = new RoomRuntime({
      model: running.manifest.model,
      roomName: manifest.roomName,
      bus: new ControlGate(built.bus, () => this.controlOn),
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
    this.shared.release(roomId);
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
      devices: r.signed.manifest.model.devices.map((d) => {
        const state = r.bus.getState(d.id);
        const driver =
          d.control?.kind === 'driver'
            ? d.control.driverId
            : d.control?.kind === 'generic'
              ? d.control.protocol
              : undefined;
        // Watched points that have been read. A device that is offline has no reading worth judging.
        const watched =
          (state?.online ?? true)
            ? (d.points ?? []).flatMap((p) => {
                const value = p.watch ? state?.points[p.id] : undefined;
                if (!p.watch || value === undefined) return [];
                const result = checkWatch(p.name, p.watch, value);
                return [
                  {
                    pointId: p.id,
                    name: p.name,
                    ok: result.ok,
                    ...(result.ok ? {} : { message: result.message }),
                    severity: p.watch.severity,
                  },
                ];
              })
            : [];
        // Everything the driver reports back, monitored room or not: this never touches control.
        const feedback = deviceFeedback(state, d.ports);
        return {
          deviceId: d.id,
          name: d.name,
          online: state?.online ?? true,
          ...(driver && { driver }),
          ...(state?.firmware && { firmware: state.firmware }),
          ...(watched.length > 0 && { watched }),
          ...(Object.keys(feedback).length > 0 && { feedback }),
        };
      }),
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
    // Whether anyone is in the room, for the cloud's usage reports.
    const occupancy = occupancyTracker((occupied, deviceId) =>
      this.emit({
        at: at(),
        type: 'room.occupancy',
        roomId: room.roomId,
        data: { occupied, deviceId },
      }),
    );
    for (const id of names.keys()) occupancy(id, room.bus.getState(id)?.occupied);
    const stopDevices = room.bus.subscribe(({ deviceId, state }) => {
      if (names.has(deviceId)) occupancy(deviceId, state.occupied);
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
        // A device that serves one room at a time is held while the room is on.
        if (status === 'starting' || status === 'on')
          this.shared.acquire(room.roomId, room.signed.manifest.roomName);
        else if (status === 'off') this.shared.release(room.roomId);
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
