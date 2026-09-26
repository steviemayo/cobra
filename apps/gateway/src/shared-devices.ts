import type {
  ControlPoint,
  Device,
  DeviceCommand,
  DeviceState,
  PointReading,
  QuickActionId,
} from '@kestrel/model';
import type { DeviceDriver } from '@kestrel/drivers/real';
import type { Logger } from './log';

// Shared site devices on the gateway (docs/driver-classes.md, "Shared devices"). One driver and one
// connection per physical device, however many rooms use it. Each room gets a view of it that
// speaks the room's own ports and control points, queues its commands behind everyone else's,
// hears the feedback, and (for a device that serves one room at a time) is refused while another
// room holds it. Every room that shares a device must run on this one gateway.

export interface Entry {
  siteDeviceId: string;
  exclusive: boolean;
  /** The device as the driver was built from it. Its control points are the union of every room's. */
  device: Device;
  driver: DeviceDriver;
  views: Set<View>;
  /** Commands run one at a time, in the order they arrived. */
  tail: Promise<unknown>;
  started: boolean;
  /** The room that has it, when it is exclusive and in use. */
  holder: { roomId: string; roomName: string } | null;
}

let attachCounter = 0;

export class SharedDevices {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly log: Logger) {}

  /** How many shared devices have a connection open. */
  get size() {
    return this.entries.size;
  }

  /**
   * Give a room its view of a shared device, opening the connection if it is the first room.
   * `device` is the room's device with the shared device's address and login already merged in.
   */
  attach(input: {
    siteDeviceId: string;
    exclusive: boolean;
    roomId: string;
    roomName: string;
    device: Device;
    build: (device: Device) => DeviceDriver | null;
  }): DeviceDriver | null {
    let entry = this.entries.get(input.siteDeviceId);
    if (!entry) {
      const device: Device = { ...structuredClone(input.device), points: [] };
      const driver = input.build(device);
      if (!driver) return null;
      entry = {
        siteDeviceId: input.siteDeviceId,
        exclusive: input.exclusive,
        device,
        driver,
        views: new Set(),
        tail: Promise.resolve(),
        started: false,
        holder: null,
      };
      this.entries.set(input.siteDeviceId, entry);
      this.log('info', 'Opened a shared device', { device: input.device.name, siteDeviceId: input.siteDeviceId });
    }
    entry.exclusive = input.exclusive;
    const view = new View(this, entry, input.roomId, input.roomName, input.device, `${input.roomId}#${++attachCounter}`);
    entry.views.add(view);
    for (const p of input.device.points ?? []) entry.device.points!.push({ ...p, id: view.namespaced(p.id) });
    return view;
  }

  /** A room turned on and wants the devices that serve one room at a time. Free ones are taken. */
  acquire(roomId: string, roomName: string) {
    for (const entry of this.entries.values()) {
      if (!entry.exclusive || entry.holder || ![...entry.views].some((v) => v.roomId === roomId)) continue;
      entry.holder = { roomId, roomName };
    }
  }

  release(roomId: string) {
    for (const entry of this.entries.values()) if (entry.holder?.roomId === roomId) entry.holder = null;
  }

  /** Who has a shared device, for diagnostics. */
  holderOf(siteDeviceId: string): string | null {
    return this.entries.get(siteDeviceId)?.holder?.roomName ?? null;
  }

  /** @internal Called by a view when its room lets go. */
  detach(entry: Entry, view: View) {
    entry.views.delete(view);
    entry.device.points = (entry.device.points ?? []).filter((p) => !p.id.startsWith(`${view.attachId}::`));
    if (entry.views.size > 0) return;
    entry.driver.close();
    this.entries.delete(entry.siteDeviceId);
    this.log('info', 'Closed a shared device', { siteDeviceId: entry.siteDeviceId });
  }
}

/** One room's view of a shared device. It looks like a driver of the room's own device. */
export class View implements DeviceDriver {
  private off: (() => void)[] = [];
  private closed = false;

  constructor(
    private readonly host: SharedDevices,
    private readonly entry: Entry,
    readonly roomId: string,
    private readonly roomName: string,
    private readonly device: Device,
    readonly attachId: string,
  ) {}

  get deviceId() {
    return this.device.id;
  }

  namespaced(pointId: string) {
    return `${this.attachId}::${pointId}`;
  }

  /** Room port id to the port of the physical device. A port with no mapping is the same on both. */
  private physical(portId: string) {
    return this.device.ports.find((p) => p.id === portId)?.maps ?? portId;
  }
  private local(physicalId: string, direction: 'in' | 'out') {
    return this.device.ports.find((p) => p.direction === direction && (p.maps ?? p.id) === physicalId)?.id ?? null;
  }
  private get mapped() {
    return this.device.ports.some((p) => p.maps);
  }

  private translate(command: DeviceCommand): DeviceCommand {
    switch (command.type) {
      case 'point':
        return { ...command, pointId: this.namespaced(command.pointId) };
      case 'route':
        return { ...command, inputPortId: this.physical(command.inputPortId), outputPortId: this.physical(command.outputPortId) };
      case 'select_input':
        return { ...command, portId: this.physical(command.portId) };
      default:
        return command;
    }
  }

  /** What the device says, as this room sees it: its own ports and points only. */
  private view(state: DeviceState): DeviceState {
    const out: DeviceState = { ...structuredClone(state), routes: {}, signal: {}, points: {} };
    if (!this.mapped) {
      out.routes = structuredClone(state.routes);
      out.signal = structuredClone(state.signal);
    } else {
      for (const p of this.device.ports) {
        const m = p.maps ?? p.id;
        if (p.direction === 'out' && m in state.routes) {
          const from = state.routes[m];
          out.routes[p.id] = from ? this.local(from, 'in') : null;
        }
        if (p.direction === 'in' && m in state.signal) out.signal[p.id] = state.signal[m]!;
      }
    }
    const prefix = `${this.attachId}::`;
    for (const [id, v] of Object.entries(state.points)) if (id.startsWith(prefix)) out.points[id.slice(prefix.length)] = v;
    return out;
  }

  private refused(): Error | null {
    const holder = this.entry.holder;
    if (this.entry.exclusive && holder && holder.roomId !== this.roomId)
      return new Error(`${this.device.name} is in use by ${holder.roomName}`);
    return null;
  }

  send(command: DeviceCommand): Promise<void> {
    const refusal = this.refused();
    if (refusal) return Promise.reject(refusal);
    const translated = this.translate(command);
    const run = () => this.entry.driver.send(translated);
    const result = this.entry.tail.then(run, run);
    this.entry.tail = result.catch(() => undefined);
    return result;
  }

  getState(): DeviceState {
    return this.view(this.entry.driver.getState());
  }

  quickActions(): QuickActionId[] {
    return this.entry.driver.quickActions?.() ?? [];
  }

  features(): string[] {
    return this.entry.driver.features?.() ?? [];
  }

  readPoint(point: Pick<ControlPoint, 'type' | 'address' | 'min' | 'max'>): Promise<PointReading> {
    if (!this.entry.driver.readPoint) return Promise.reject(new Error('This device cannot read control points'));
    return this.entry.driver.readPoint(point);
  }

  onChange(listener: (state: DeviceState) => void): () => void {
    const off = this.entry.driver.onChange((state) => listener(this.view(state)));
    this.off.push(off);
    return off;
  }

  start(): void {
    if (this.entry.started) return;
    this.entry.started = true;
    this.entry.driver.start();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.off.forEach((f) => f());
    this.off = [];
    this.host.detach(this.entry, this);
  }
}
