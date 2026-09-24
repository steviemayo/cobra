import { z } from 'zod';
import { LocalId } from '../room/common';

// The vocabulary the engine speaks to drivers (real or simulated). Drivers translate to protocol.
export const DeviceCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('power'), on: z.boolean() }),
  /** Destination device selects one of its own input ports. */
  z.object({ type: z.literal('select_input'), portId: LocalId }),
  /** Matrix/DSP internal route: one input port to one output port. */
  z.object({ type: z.literal('route'), inputPortId: LocalId, outputPortId: LocalId }),
  z.object({ type: z.literal('mute'), muted: z.boolean() }),
  z.object({ type: z.literal('volume'), level: z.number().int().min(0).max(100) }),
  z.object({ type: z.literal('preset'), name: z.string().min(1) }),
  z.object({ type: z.literal('camera_preset'), name: z.string().min(1) }),
  z.object({ type: z.literal('scene'), name: z.string().min(1) }),
  z.object({ type: z.literal('record'), on: z.boolean() }),
  z.object({
    type: z.literal('command'),
    name: z.string().min(1),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
]);
export type DeviceCommand = z.infer<typeof DeviceCommand>;

export const PowerState = z.enum(['off', 'warming', 'on', 'cooling']);
export type PowerState = z.infer<typeof PowerState>;

// Feedback snapshot. Drivers report what they know; unknown fields stay undefined.
export const DeviceState = z.object({
  online: z.boolean().default(true),
  power: PowerState.optional(),
  /** Destination devices: the input port currently selected. */
  selectedInput: LocalId.nullable().optional(),
  /** Matrices/DSPs: output port -> input port feeding it (null = nothing routed). */
  routes: z.record(z.string(), LocalId.nullable()).default({}),
  muted: z.boolean().optional(),
  /** 0-100, scaled by the driver from the device's native range. */
  volume: z.number().min(0).max(100).optional(),
  preset: z.string().optional(),
  recording: z.boolean().optional(),
  /** Occupancy sensors: is anyone in the room. */
  occupied: z.boolean().optional(),
  /** Input port -> is a signal present. Only devices with signal_detect report this. */
  signal: z.record(z.string(), z.boolean()).default({}),
});
export type DeviceState = z.infer<typeof DeviceState>;

export interface DeviceEvent {
  deviceId: string;
  state: DeviceState;
}

/** What the engine needs from the outside world. Implemented by real drivers and by the simulator. */
export interface DeviceBus {
  /** Resolves when the device reports the command applied ("ready"); rejects if it fails. */
  send(deviceId: string, command: DeviceCommand): Promise<void>;
  getState(deviceId: string): DeviceState | undefined;
  subscribe(listener: (event: DeviceEvent) => void): () => void;
}

export const defaultDeviceState = (): DeviceState => ({ online: true, routes: {}, signal: {} });
