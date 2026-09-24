import type { Activity, RoomModel } from '@kestrel/model';
import {
  buildGraph,
  deviceCapabilities,
  roomCapabilities,
  splitPortKey,
  type Graph,
} from '../validate/graph';
import { activitySources } from '../plan/plan';

/**
 * The activities a panel should offer: not hidden, every required capability present in the room,
 * and enough equipment to actually do the job. Everything else is quietly left out.
 */
export function availableActivities(model: RoomModel): Activity[] {
  const have = roomCapabilities(model);
  const hasDisplays = model.groups.some(
    (g) => g.kind === 'display' && g.members.some((id) => model.devices.some((d) => d.id === id)),
  );
  return model.activities.filter((a) => {
    if (a.hidden) return false;
    if (!a.requires.every((c) => have.has(c))) return false;
    if (a.kind === 'present' || a.kind === 'video_call')
      return activitySources(model, a).length > 0 && hasDisplays;
    if (a.kind === 'record') return model.devices.some((d) => d.category === 'recorder');
    return true;
  });
}

export interface SignalDetector {
  deviceId: string;
  portId: string;
}

/**
 * Where does a source's signal show up first? The first device downstream that can detect signal
 * (typically the matrix input the laptop is plugged into). Null when the room can't tell.
 */
export function findDetector(
  model: RoomModel,
  graph: Graph,
  sourceDeviceId: string,
): SignalDetector | null {
  const source = graph.devices.get(sourceDeviceId);
  if (!source) return null;
  const queue = source.ports
    .filter((p) => p.direction === 'out')
    .map((p) => `${sourceDeviceId}\u0000${p.id}`);
  const seen = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const outKey = queue[i]!;
    if (seen.has(outKey)) continue;
    seen.add(outKey);
    for (const inKey of graph.edges.get(outKey) ?? []) {
      const [deviceId, portId] = splitPortKey(inKey);
      const device = graph.devices.get(deviceId);
      if (!device) continue;
      if (deviceCapabilities(device).has('signal_detect')) return { deviceId, portId };
      for (const p of device.ports)
        if (p.direction === 'out') queue.push(`${deviceId}\u0000${p.id}`);
    }
  }
  void model;
  return null;
}

export function detectorsFor(model: RoomModel): Map<string, SignalDetector | null> {
  const graph = buildGraph(model);
  const out = new Map<string, SignalDetector | null>();
  for (const a of model.activities)
    for (const s of a.sources)
      if (!out.has(s.deviceId)) out.set(s.deviceId, findDetector(model, graph, s.deviceId));
  return out;
}
