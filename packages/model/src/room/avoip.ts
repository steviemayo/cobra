import { BUILT_IN_DRIVERS } from './drivers';
import { DEVICE_CATALOG } from './catalog';
import type { Device } from './device';
import type { RoomModel } from './room-model';

// "Add AVoIP system" (docs/driver-classes.md): choose a family, say how many encoders and decoders,
// and the virtual switcher plus its endpoints are created and wired the way the real system is:
// source, encoder, switcher, decoder, display. The sources and displays are wired by the dev.

/** The AVoIP families that have all three drivers, by the family id their drivers share. */
export function avoipFamilies(): { id: string; label: string }[] {
  const found = new Map<string, Set<string>>();
  for (const info of Object.values(BUILT_IN_DRIVERS))
    if (info.family) found.set(info.family, (found.get(info.family) ?? new Set()).add(info.class));
  const labels: Record<string, string> = { 'crestron-nvx': 'Crestron NVX' };
  return [...found]
    .filter(([, classes]) => ['avoip_encoder', 'avoip_decoder', 'avoip_switching'].every((c) => classes.has(c)))
    .map(([id]) => ({ id, label: labels[id] ?? id }));
}

export const MAX_AVOIP_ENDPOINTS = 64;

const unique = (base: string, taken: Set<string>) => {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
};

export interface AvoipSystemResult {
  ok: boolean;
  message?: string;
  switcherId?: string;
  encoderIds?: string[];
  decoderIds?: string[];
}

/** Adds an AVoIP system to a room. Refuses a family with no drivers, or a size that makes no sense. */
export function addAvoipSystem(
  model: RoomModel,
  opts: { family: string; encoders: number; decoders: number },
): AvoipSystemResult {
  if (!avoipFamilies().some((f) => f.id === opts.family))
    return { ok: false, message: 'That AVoIP family has no drivers yet' };
  const { encoders, decoders } = opts;
  if (!Number.isInteger(encoders) || !Number.isInteger(decoders) || encoders < 1 || decoders < 1)
    return { ok: false, message: 'A system needs at least one encoder and one decoder' };
  if (encoders + decoders > MAX_AVOIP_ENDPOINTS)
    return { ok: false, message: `Up to ${MAX_AVOIP_ENDPOINTS} encoders and decoders at a time` };

  const taken = new Set(model.devices.map((d) => d.id));
  const control = (kind: 'encoder' | 'decoder' | 'switcher') =>
    ({ kind: 'driver', driverId: `${opts.family}-${kind}` }) as const;
  const ports = (category: 'avoip_encoder' | 'avoip_decoder') =>
    DEVICE_CATALOG[category].defaultPorts.map((p) => ({ ...p }));

  const switcherId = unique('avoip-switcher', taken);
  const switcher: Device = {
    id: switcherId,
    name: 'AVoIP switcher',
    category: 'video_matrix',
    ports: [
      ...Array.from({ length: encoders }, (_, i) => ({ id: `in${i + 1}`, name: `Encoder ${i + 1}`, direction: 'in' as const, signal: 'av' as const })),
      ...Array.from({ length: decoders }, (_, i) => ({ id: `out${i + 1}`, name: `Decoder ${i + 1}`, direction: 'out' as const, signal: 'av' as const })),
    ],
    extraCapabilities: [],
    settings: {},
    control: control('switcher'),
  };
  const encoderIds: string[] = [];
  const decoderIds: string[] = [];
  const devices: Device[] = [switcher];
  const connections: RoomModel['connections'] = [];
  for (let i = 1; i <= encoders; i++) {
    const id = unique(`avoip-enc-${i}`, taken);
    encoderIds.push(id);
    devices.push({ id, name: `Encoder ${i}`, category: 'avoip_encoder', ports: ports('avoip_encoder'), extraCapabilities: [], settings: {}, control: control('encoder') });
    connections.push({ id: `${id}-to-${switcherId}`, from: { deviceId: id, portId: 'net' }, to: { deviceId: switcherId, portId: `in${i}` } });
  }
  for (let j = 1; j <= decoders; j++) {
    const id = unique(`avoip-dec-${j}`, taken);
    decoderIds.push(id);
    devices.push({ id, name: `Decoder ${j}`, category: 'avoip_decoder', ports: ports('avoip_decoder'), extraCapabilities: [], settings: {}, control: control('decoder') });
    connections.push({ id: `${switcherId}-to-${id}`, from: { deviceId: switcherId, portId: `out${j}` }, to: { deviceId: id, portId: 'net' } });
  }
  model.devices.push(...devices);
  model.connections.push(...connections);
  return { ok: true, switcherId, encoderIds, decoderIds };
}
