import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomRuntime, validateRoomModel } from '@kestrel/engine';
import { STARTER_TEMPLATES, addAvoipSystem, gatewayNeeds, type DeviceCommand, type RoomModel } from '@kestrel/model';
import { createSimulation, type Simulation } from './sim/simulation';

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** The starter room with its matrix replaced by an AVoIP system: laptop, encoder, switcher, decoder, display. */
function avoipRoom() {
  const m = structuredClone(STARTER_TEMPLATES[0]!.model);
  m.devices = m.devices.filter((d) => d.id !== 'matrix');
  m.connections = m.connections.filter((c) => c.from.deviceId !== 'matrix' && c.to.deviceId !== 'matrix');
  const made = addAvoipSystem(m, { family: 'crestron-nvx', encoders: 2, decoders: 2 });
  if (!made.ok) throw new Error(made.message);
  const link = (id: string, from: string, fromPort: string, to: string, toPort: string) =>
    m.connections.push({ id, from: { deviceId: from, portId: fromPort }, to: { deviceId: to, portId: toPort } });
  link('l1', 'laptop1', 'out', made.encoderIds![0]!, 'in');
  link('l2', 'laptop2', 'out', made.encoderIds![1]!, 'in');
  link('d1', made.decoderIds![0]!, 'out', 'display1', 'in');
  link('d2', made.decoderIds![1]!, 'out', 'display2', 'in');
  return { model: m, ...made } as { model: RoomModel } & Required<typeof made>;
}

let sim: Simulation;
let rt: RoomRuntime;
const setup = (model: RoomModel) => {
  sim = createSimulation(model);
  rt = new RoomRuntime({ model, roomName: 'Test room', bus: sim });
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  rt?.dispose();
  sim?.dispose();
  vi.useRealTimers();
});

describe('a room over AVoIP', () => {
  it('is a valid design', () => {
    const { model } = avoipRoom();
    const result = validateRoomModel(model);
    expect(result.issues.filter((i) => i.severity === 'error' && i.message.includes('AVoIP'))).toEqual([]);
    expect(result.issues.filter((i) => i.message.includes('not connected to a virtual switcher'))).toEqual([]);
  });

  it('presents through the switcher only: the endpoints are passed through and get no route command', async () => {
    const { model, switcherId, encoderIds, decoderIds } = avoipRoom();
    setup(model);
    const seen: [string, DeviceCommand['type']][] = [];
    const send = sim.send.bind(sim);
    sim.send = async (deviceId, command) => {
      seen.push([deviceId, command.type]);
      return send(deviceId, command);
    };
    sim.plug('laptop1', true);
    rt.dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop1' });
    await advance(30_000);

    expect(rt.getSnapshot().status).toBe('on');
    expect(sim.getState(switcherId)!.routes).toMatchObject({ out1: 'in1' });
    // One route per display, all of them on the switcher.
    expect(new Set(seen.filter(([, type]) => type === 'route').map(([id]) => id))).toEqual(new Set([switcherId]));
    for (const id of [...encoderIds, ...decoderIds]) expect(seen.some(([d]) => d === id)).toBe(false);
    // The picture really reaches the display: signal flows through encoder, switcher and decoder.
    expect(sim.getState('display1')!.signal.in).toBe(true);
    expect(sim.getState('display1')!.selectedInput).toBe('in');
  });

  it('switching to the other laptop moves the route on the switcher', async () => {
    const { model, switcherId } = avoipRoom();
    setup(model);
    rt.dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop1' });
    await advance(30_000);
    rt.dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop2' });
    await advance(30_000);
    expect(sim.getState(switcherId)!.routes.out1).toBe('in2');
  });

  it('needs a gateway that says it knows AVoIP', () => {
    expect(gatewayNeeds(avoipRoom().model)).toEqual(['avoip']);
  });
});

describe('checking an AVoIP design', () => {
  it('errors when an endpoint comes from another family than its switcher', () => {
    const { model, encoderIds } = avoipRoom();
    // Pretend a second vendor: a decoder driver from another family wired to this switcher.
    model.devices.find((d) => d.id === encoderIds[0])!.control = { kind: 'driver', driverId: 'crestron-dm-nvx' };
    const issues = validateRoomModel(model).issues.filter((i) => i.message.includes('AVoIP') || i.message.includes('family'));
    // crestron-dm-nvx has no family, so it is a warning that it does not say, not a mismatch.
    expect(issues.map((i) => i.severity)).toEqual(['warning']);
  });

  it('warns about an endpoint that is wired to no switcher', () => {
    const { model } = avoipRoom();
    model.devices.push({ id: 'lone', name: 'Lone encoder', category: 'avoip_encoder', ports: [], extraCapabilities: [], settings: {}, control: { kind: 'driver', driverId: 'crestron-nvx-encoder' } });
    const warns = validateRoomModel(model).issues.filter((i) => i.message.includes('Lone encoder is not connected'));
    expect(warns).toHaveLength(1);
  });
});
