import {
  defaultDeviceState,
  type Device,
  type DeviceBus,
  type DeviceCommand,
  type DeviceEvent,
  type DeviceState,
  type RoomModel,
} from '@kestrel/model';
import { buildGraph, splitPortKey, portKey, type Graph } from '@kestrel/engine';

export interface SimLatency {
  displayOn: number;
  displayOff: number;
  route: number;
  dsp: number;
  camera: number;
  record: number;
  generic: number;
}

export const DEFAULT_LATENCY: SimLatency = {
  displayOn: 2500,
  displayOff: 1200,
  route: 150,
  dsp: 80,
  camera: 900,
  record: 400,
  generic: 100,
};

export interface SimulationOptions {
  /** Multiplies every delay. 0 = instant, 1 = realistic, 0.25 = fast demo. */
  latencyScale?: number;
  latency?: Partial<SimLatency>;
}

export interface DeviceFault {
  /** The device drops off the network: state.online=false and every command fails. */
  offline?: boolean;
  /** The device is reachable but fails every command. */
  rejectCommands?: boolean;
}

const CAMERAS = new Set(['conf_camera', 'fixed_camera', 'ptz_camera', 'autoframing_camera']);
const ALWAYS_ON_SOURCES = new Set([
  'audio_source',
  'reinforcement_mic',
  'voice_capture_mic',
  'conference_system',
  ...CAMERAS,
]);
const ENVIRONMENT = new Set(['lighting', 'hvac', 'blinds', 'lifter', 'screen']);

/**
 * Simulated room hardware behind the same DeviceBus the real drivers implement. Devices take time
 * to respond, reject commands they can't handle, and signal really propagates through the routing,
 * so the engine is exercised exactly as it would be against real equipment.
 */
export class Simulation implements DeviceBus {
  private readonly graph: Graph;
  private readonly devices = new Map<string, Device>();
  private readonly states = new Map<string, DeviceState>();
  private readonly plugged = new Map<string, boolean>();
  private readonly faults = new Map<string, DeviceFault>();
  private readonly listeners = new Set<(e: DeviceEvent) => void>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly latency: SimLatency;
  private scale: number;
  private flowing = new Set<string>();

  constructor(model: RoomModel, opts: SimulationOptions = {}) {
    this.graph = buildGraph(model);
    this.latency = { ...DEFAULT_LATENCY, ...opts.latency };
    this.scale = opts.latencyScale ?? 1;
    for (const d of model.devices) {
      this.devices.set(d.id, d);
      this.states.set(d.id, this.initialState(d));
      if (d.category === 'video_source') this.plugged.set(d.id, false);
    }
    this.recompute(false);
  }

  // ---- DeviceBus ------------------------------------------------------------------------------

  getState(deviceId: string): DeviceState | undefined {
    const s = this.states.get(deviceId);
    return s && structuredClone(s);
  }

  subscribe(listener: (event: DeviceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(deviceId: string, command: DeviceCommand): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Unknown device ${deviceId}`);
    const fault = this.faults.get(deviceId);
    if (fault?.offline) throw new Error(`${device.name} is offline`);
    if (fault?.rejectCommands) throw new Error(`${device.name} did not respond`);
    await this.apply(device, command);
  }

  // ---- Simulator controls (what a person or a test does to the room) ---------------------------

  /** Change how long devices take to respond, from now on. */
  setLatencyScale(scale: number) {
    this.scale = scale;
  }

  /** Plug or unplug a laptop's cable. */
  plug(deviceId: string, present: boolean) {
    if (!this.plugged.has(deviceId)) throw new Error(`${deviceId} is not a pluggable source`);
    this.plugged.set(deviceId, present);
    this.recompute(true);
  }

  /** Someone walks into (or out of) the room, for an occupancy sensor. */
  setOccupied(deviceId: string, occupied: boolean) {
    const state = this.states.get(deviceId);
    if (!state || this.devices.get(deviceId)?.category !== 'occupancy_sensor')
      throw new Error(`${deviceId} is not an occupancy sensor`);
    state.occupied = occupied;
    this.emit(deviceId);
  }

  isPlugged(deviceId: string): boolean {
    return this.plugged.get(deviceId) ?? false;
  }

  setFault(deviceId: string, fault: DeviceFault | null) {
    if (fault) this.faults.set(deviceId, fault);
    else this.faults.delete(deviceId);
    const state = this.states.get(deviceId);
    if (state) {
      state.online = !fault?.offline;
      this.emit(deviceId);
    }
  }

  getFault(deviceId: string): DeviceFault | undefined {
    return this.faults.get(deviceId);
  }

  /** Ids of connections that currently carry a signal, for visualisation. */
  flow(): ReadonlySet<string> {
    return this.flowing;
  }

  allStates(): Record<string, DeviceState> {
    return Object.fromEntries([...this.states].map(([id, s]) => [id, structuredClone(s)]));
  }

  dispose() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.listeners.clear();
  }

  // ---- Internals ------------------------------------------------------------------------------

  private initialState(d: Device): DeviceState {
    const s = defaultDeviceState();
    switch (d.category) {
      case 'video_destination':
        s.power = 'off';
        s.selectedInput = null;
        break;
      case 'video_matrix':
        for (const p of d.ports) if (p.direction === 'out') s.routes[p.id] = null;
        break;
      case 'audio_matrix': {
        const ins = d.ports.filter((p) => p.direction === 'in');
        const outs = d.ports.filter((p) => p.direction === 'out');
        for (const o of outs) s.routes[o.id] = ins.length === 1 ? ins[0]!.id : null;
        s.muted = true;
        s.volume = 50;
        break;
      }
      case 'recorder':
        s.recording = false;
        break;
      case 'occupancy_sensor':
        s.occupied = false;
        break;
    }
    for (const p of d.ports)
      if (p.direction === 'in' && this.reportsSignal(d)) s.signal[p.id] = false;
    return s;
  }

  private reportsSignal(d: Device) {
    return d.category === 'video_matrix' || d.category === 'video_destination';
  }

  private delay(ms: number): Promise<void> {
    const scaled = ms * this.scale;
    if (scaled <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        resolve();
      }, scaled);
      this.timers.add(t);
    });
  }

  private emit(deviceId: string) {
    const state = this.getState(deviceId);
    if (!state) return;
    for (const l of this.listeners) l({ deviceId, state });
  }

  private unsupported(d: Device, c: DeviceCommand): never {
    throw new Error(`${d.name} doesn't support ${c.type}`);
  }

  private async apply(d: Device, c: DeviceCommand): Promise<void> {
    const state = this.states.get(d.id)!;
    const cat = d.category;
    switch (c.type) {
      case 'power': {
        if (cat !== 'video_destination') return this.unsupported(d, c);
        if (c.on && state.power !== 'on') {
          state.power = 'warming';
          this.emit(d.id);
          await this.delay(this.latency.displayOn);
          state.power = 'on';
        } else if (!c.on && state.power !== 'off') {
          state.power = 'cooling';
          this.emit(d.id);
          await this.delay(this.latency.displayOff);
          state.power = 'off';
          state.selectedInput = null;
        }
        break;
      }
      case 'select_input': {
        if (cat !== 'video_destination') return this.unsupported(d, c);
        if (!d.ports.some((p) => p.id === c.portId && p.direction === 'in'))
          throw new Error(`${d.name} has no input ${c.portId}`);
        if (state.power !== 'on') throw new Error(`${d.name} isn't on yet`);
        await this.delay(this.latency.generic);
        state.selectedInput = c.portId;
        break;
      }
      case 'route': {
        if (cat !== 'video_matrix' && cat !== 'audio_matrix') return this.unsupported(d, c);
        const inOk = d.ports.some((p) => p.id === c.inputPortId && p.direction === 'in');
        const outOk = d.ports.some((p) => p.id === c.outputPortId && p.direction === 'out');
        if (!inOk || !outOk)
          throw new Error(`${d.name} has no route ${c.inputPortId} to ${c.outputPortId}`);
        await this.delay(cat === 'video_matrix' ? this.latency.route : this.latency.dsp);
        state.routes[c.outputPortId] = c.inputPortId;
        break;
      }
      case 'mute':
      case 'volume':
      case 'preset': {
        if (cat !== 'audio_matrix') return this.unsupported(d, c);
        await this.delay(this.latency.dsp);
        if (c.type === 'mute') state.muted = c.muted;
        else if (c.type === 'volume') state.volume = c.level;
        else state.preset = c.name;
        break;
      }
      case 'camera_preset': {
        if (!CAMERAS.has(cat)) return this.unsupported(d, c);
        await this.delay(this.latency.camera);
        state.preset = c.name;
        break;
      }
      case 'record': {
        if (cat !== 'recorder') return this.unsupported(d, c);
        await this.delay(this.latency.record);
        state.recording = c.on;
        break;
      }
      case 'scene': {
        if (!ENVIRONMENT.has(cat)) return this.unsupported(d, c);
        await this.delay(this.latency.generic * 3);
        state.preset = c.name;
        break;
      }
      case 'command': {
        await this.delay(this.latency.generic);
        break;
      }
    }
    // A fault injected while the command was in flight still wins.
    if (this.faults.get(d.id)?.offline) throw new Error(`${d.name} is offline`);
    this.emit(d.id);
    this.recompute(true);
  }

  /** Work out where signal reaches, given who is plugged in and how everything is routed. */
  private recompute(notify: boolean) {
    const present = new Set<string>(); // out-port keys carrying signal
    const arriving = new Set<string>(); // in-port keys receiving signal
    const flowing = new Set<string>();
    const queue: string[] = [];

    for (const d of this.devices.values()) {
      const source =
        d.category === 'video_source'
          ? this.plugged.get(d.id) === true
          : ALWAYS_ON_SOURCES.has(d.category);
      if (!source || this.faults.get(d.id)?.offline) continue;
      for (const p of d.ports)
        if (p.direction === 'out') {
          present.add(portKey(d.id, p.id));
          queue.push(portKey(d.id, p.id));
        }
    }

    while (queue.length) {
      const outKey = queue.pop()!;
      for (const inKey of this.graph.edges.get(outKey) ?? []) {
        flowing.add(this.graph.connectionIds.get(`${outKey}\u0001${inKey}`)!);
        arriving.add(inKey);
        const [deviceId, inPortId] = splitPortKey(inKey);
        const device = this.devices.get(deviceId)!;
        if (device.category !== 'video_matrix' && device.category !== 'audio_matrix') continue;
        if (this.faults.get(deviceId)?.offline) continue;
        const routes = this.states.get(deviceId)!.routes;
        for (const [outPortId, from] of Object.entries(routes)) {
          const k = portKey(deviceId, outPortId);
          if (from === inPortId && !present.has(k)) {
            present.add(k);
            queue.push(k);
          }
        }
      }
    }

    this.flowing = flowing;
    for (const d of this.devices.values()) {
      if (!this.reportsSignal(d)) continue;
      const state = this.states.get(d.id)!;
      let changed = false;
      for (const p of d.ports)
        if (p.direction === 'in') {
          const now = arriving.has(portKey(d.id, p.id));
          if (state.signal[p.id] !== now) {
            state.signal[p.id] = now;
            changed = true;
          }
        }
      if (changed && notify) this.emit(d.id);
    }
  }
}

export function createSimulation(model: RoomModel, opts?: SimulationOptions): Simulation {
  return new Simulation(model, opts);
}
