import {
  DEVICE_CATALOG,
  signalCarries,
  type Capability,
  type Device,
  type Port,
  type RoomModel,
  type SignalKind,
} from '@kestrel/model';

const VIDEO = 1;
const AUDIO = 2;

function media(signal: SignalKind): number {
  return (
    (signalCarries(signal, 'video') ? VIDEO : 0) | (signalCarries(signal, 'audio') ? AUDIO : 0)
  );
}

export function deviceCapabilities(device: Device): Set<Capability> {
  return new Set([...DEVICE_CATALOG[device.category].capabilities, ...device.extraCapabilities]);
}

export function roomCapabilities(model: RoomModel): Set<Capability> {
  const all = new Set<Capability>();
  for (const d of model.devices) for (const c of deviceCapabilities(d)) all.add(c);
  return all;
}

export interface Graph {
  devices: Map<string, Device>;
  ports: Map<string, Port>;
  /** `deviceId:portId` -> connected `deviceId:portId` keys (out -> in only). */
  edges: Map<string, string[]>;
}

const key = (deviceId: string, portId: string) => `${deviceId}\u0000${portId}`;
const split = (k: string): [string, string] => k.split('\u0000') as [string, string];

export function buildGraph(model: RoomModel): Graph {
  const devices = new Map(model.devices.map((d) => [d.id, d]));
  const ports = new Map<string, Port>();
  for (const d of model.devices) for (const p of d.ports) ports.set(key(d.id, p.id), p);
  const edges = new Map<string, string[]>();
  for (const c of model.connections) {
    const from = ports.get(key(c.from.deviceId, c.from.portId));
    const to = ports.get(key(c.to.deviceId, c.to.portId));
    if (from?.direction !== 'out' || to?.direction !== 'in') continue;
    const fk = key(c.from.deviceId, c.from.portId);
    edges.set(fk, [...(edges.get(fk) ?? []), key(c.to.deviceId, c.to.portId)]);
  }
  return { devices, ports, edges };
}

function passThroughMedia(device: Device): number {
  const caps = deviceCapabilities(device);
  return (caps.has('video_route') ? VIDEO : 0) | (caps.has('audio_route') ? AUDIO : 0);
}

/** Can a signal leave `src` and arrive at `dst`, passing only through routing devices (matrices/DSP)? */
export function canRoute(
  g: Graph,
  src: { deviceId: string; portId?: string },
  dst: { deviceId: string; portId?: string },
): boolean {
  const srcDevice = g.devices.get(src.deviceId);
  if (!srcDevice || !g.devices.has(dst.deviceId) || src.deviceId === dst.deviceId) return false;
  const seen = new Set<string>();

  const walk = (outKey: string, m: number): boolean => {
    const seenKey = `${outKey}|${m}`;
    if (seen.has(seenKey)) return false;
    seen.add(seenKey);
    for (const inKey of g.edges.get(outKey) ?? []) {
      const inPort = g.ports.get(inKey);
      if (!inPort) continue;
      const m2 = m & media(inPort.signal);
      if (m2 === 0) continue;
      const [devId, portId] = split(inKey);
      if (devId === dst.deviceId) {
        if (!dst.portId || dst.portId === portId) return true;
        continue;
      }
      const through = g.devices.get(devId);
      if (!through) continue;
      const m3 = m2 & passThroughMedia(through);
      if (m3 === 0) continue;
      for (const outPort of through.ports) {
        if (outPort.direction !== 'out') continue;
        const m4 = m3 & media(outPort.signal);
        if (m4 !== 0 && walk(key(devId, outPort.id), m4)) return true;
      }
    }
    return false;
  };

  return srcDevice.ports.some(
    (p) =>
      p.direction === 'out' &&
      (!src.portId || src.portId === p.id) &&
      walk(key(src.deviceId, p.id), media(p.signal)),
  );
}

/** Devices reachable downstream (following connections, any hops) from a device. */
export function downstreamDevices(g: Graph, deviceId: string): Set<string> {
  const found = new Set<string>();
  const queue = [deviceId];
  while (queue.length) {
    const current = queue.pop()!;
    for (const [outKey, ins] of g.edges) {
      if (split(outKey)[0] !== current) continue;
      for (const inKey of ins) {
        const next = split(inKey)[0];
        if (!found.has(next) && next !== deviceId) {
          found.add(next);
          queue.push(next);
        }
      }
    }
  }
  return found;
}

export { key as portKey };
