import type { Device, DeviceCommand, DeviceState, RoomModel } from '@kestrel/model';
import { BaseDriver } from './base';
import type { DeviceDriver, DriverContext } from './types';

// The virtual switcher of an AVoIP system (docs/driver-classes.md, "Video switching (AVoIP)"). It has
// no address of its own: it is the routing logic. The encoders and decoders are ordinary devices in
// the room, wired to it by their network ports. To route an input to an output it:
//   1. asks the encoder where its stream can be picked up,
//   2. gives that location to the decoder,
//   3. waits until the decoder says it is receiving (no fixed delay), then reports done.
// It keeps a table of the routes it was asked for, and re-applies one when its decoder comes back
// after a reboot, and when an encoder's stream moves ("follow the stream"). To the engine it is a
// matrix: a `route` command and a `routes` state.

const DEFAULT_WAIT_MS = 8000;
const REAPPLY_COOLDOWN_MS = 2000;

interface Wiring {
  /** Switcher input port to the encoder wired to it. */
  encoders: Map<string, string>;
  /** Switcher output port to the decoder wired to it. */
  decoders: Map<string, string>;
}

/** Which encoder feeds each switcher input and which decoder each output feeds, from the connections. */
export function avoipWiring(model: RoomModel, switcherId: string): Wiring {
  const byId = new Map(model.devices.map((d) => [d.id, d]));
  const wiring: Wiring = { encoders: new Map(), decoders: new Map() };
  for (const c of model.connections) {
    if (c.to.deviceId === switcherId && byId.get(c.from.deviceId)?.category === 'avoip_encoder')
      wiring.encoders.set(c.to.portId, c.from.deviceId);
    if (c.from.deviceId === switcherId && byId.get(c.to.deviceId)?.category === 'avoip_decoder')
      wiring.decoders.set(c.from.portId, c.to.deviceId);
  }
  return wiring;
}

export class AvoipSwitcher extends BaseDriver {
  private readonly wiring: Wiring;
  /** The routes asked for: switcher output port to switcher input port. */
  private readonly desired = new Map<string, string>();
  /** The last stream location seen for each encoder. */
  private readonly locations = new Map<string, string>();
  private readonly lastOnline = new Map<string, boolean>();
  private readonly lastApplied = new Map<string, number>();
  private off: (() => void)[] = [];
  private closed = false;

  constructor(
    device: Device,
    model: RoomModel,
    private readonly endpoints: Map<string, DeviceDriver>,
    ctx: DriverContext,
  ) {
    super(device, ctx);
    this.wiring = avoipWiring(model, device.id);
    this.state.online = false;
    for (const out of this.wiring.decoders.keys()) this.state.routes[out] = null;
    this.recompute();
  }

  private get waitMs() {
    return this.setting<number>('timeoutMs', DEFAULT_WAIT_MS);
  }

  private used(): string[] {
    return [...new Set([...this.wiring.encoders.values(), ...this.wiring.decoders.values()])];
  }

  override features() {
    return ['route', 'signal_detect'];
  }

  override start() {
    this.closed = false;
    for (const id of this.used()) {
      const driver = this.endpoints.get(id);
      if (!driver) continue;
      this.lastOnline.set(id, driver.getState().online);
      this.off.push(driver.onChange((s) => this.onEndpoint(id, s)));
    }
    this.recompute();
  }

  override close() {
    this.closed = true;
    this.off.forEach((f) => f());
    this.off = [];
  }

  /** What the endpoints say, folded into this switcher: online only if every endpoint is, and a signal per input. */
  private recompute() {
    let online = this.used().length > 0;
    const signal: Record<string, boolean> = {};
    for (const id of this.used()) if (!(this.endpoints.get(id)?.getState().online ?? false)) online = false;
    for (const [inPort, encId] of this.wiring.encoders) {
      const s = this.endpoints.get(encId)?.getState().signal ?? {};
      signal[inPort] = Object.values(s).some(Boolean);
    }
    this.update((s) => {
      s.online = online;
      s.signal = signal;
      s.routes = Object.fromEntries([...this.wiring.decoders.keys()].map((o) => [o, this.desired.get(o) ?? null]));
    });
  }

  private onEndpoint(id: string, state: DeviceState) {
    if (this.closed) return;
    const encoderPorts = [...this.wiring.encoders].filter(([, enc]) => enc === id).map(([p]) => p);
    if (encoderPorts.length > 0 && state.streamLocation) {
      const before = this.locations.get(id);
      this.locations.set(id, state.streamLocation);
      // The stream moved (the encoder came back with a new id): point every decoder that shows it at the new one.
      if (before && before !== state.streamLocation)
        for (const [out, from] of this.desired) if (encoderPorts.includes(from)) void this.reapply(out);
    }
    const outs = [...this.wiring.decoders].filter(([, dec]) => dec === id).map(([p]) => p);
    if (outs.length > 0) {
      const wasOnline = this.lastOnline.get(id) ?? state.online;
      this.lastOnline.set(id, state.online);
      // A decoder that came back from a reboot, or lost its stream, is pointed at its source again.
      if (state.online && (!wasOnline || state.streamConnected === false))
        for (const out of outs) if (this.desired.has(out)) void this.reapply(out);
    }
    this.recompute();
  }

  private async reapply(out: string) {
    const now = Date.now();
    if (now - (this.lastApplied.get(out) ?? 0) < REAPPLY_COOLDOWN_MS) return;
    this.lastApplied.set(out, now);
    const from = this.desired.get(out);
    if (!from || this.closed) return;
    try {
      await this.point(from, out);
    } catch (e) {
      this.ctx.log('warn', 'Could not re-apply an AVoIP route', {
        device: this.device.name,
        output: out,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Steps 1 to 3 for one route. */
  private async point(inPort: string, outPort: string) {
    const encId = this.wiring.encoders.get(inPort);
    const decId = this.wiring.decoders.get(outPort);
    if (!encId) this.fail(`input ${inPort} has no encoder wired to it`);
    if (!decId) this.fail(`output ${outPort} has no decoder wired to it`);
    const enc = this.endpoints.get(encId);
    const dec = this.endpoints.get(decId);
    if (!enc?.streamLocation) this.fail(`the encoder for ${inPort} has no driver that can report its stream`);
    if (!dec) this.fail(`the decoder for ${outPort} has no driver`);
    const location = await enc.streamLocation();
    this.locations.set(encId, location);
    await dec.send({ type: 'set_stream', location });
    await this.until(dec, (s) => s.streamConnected === true, `${this.endpointName(decId)} is not receiving the stream`);
  }

  private endpointName(id: string) {
    return this.endpoints.get(id)?.deviceId ?? id;
  }

  /** Waits for a decoder to say it is receiving, as soon as it does. */
  private until(driver: DeviceDriver, done: (s: DeviceState) => boolean, message: string): Promise<void> {
    if (done(driver.getState())) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`${this.device.name}: ${message}`));
      }, this.waitMs);
      const off = driver.onChange((s) => {
        if (!done(s)) return;
        clearTimeout(timer);
        off();
        resolve();
      });
    });
  }

  async send(command: DeviceCommand): Promise<void> {
    switch (command.type) {
      case 'route': {
        await this.point(command.inputPortId, command.outputPortId);
        this.desired.set(command.outputPortId, command.inputPortId);
        this.recompute();
        return;
      }
      case 'power':
      case 'select_input':
        return;
      default:
        this.fail(`does not support "${command.type}"`);
    }
  }
}

/** The driver ids that are a virtual switcher. They need the other devices of the room, so the room builds them. */
export const AVOIP_SWITCHER_IDS = new Set(['crestron-nvx-switcher']);

/** Add the virtual switchers of a room to its real drivers. Endpoints must already be in `real`. */
export function attachVirtualDrivers(
  model: RoomModel,
  real: Map<string, DeviceDriver>,
  ctx: DriverContext,
) {
  for (const d of model.devices) {
    if (d.control?.kind !== 'driver' || !AVOIP_SWITCHER_IDS.has(d.control.driverId)) continue;
    real.set(d.id, new AvoipSwitcher(d, model, real, ctx));
  }
}
