import { z } from 'zod';
import { DisplayKey, LocalId } from '../room/common';
import type { ControlPoint, PointReading } from '../room/points';
import type { QuickActionId } from './quick-actions';

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
  /**
   * Point a camera: pan and tilt left/right and up/down, zoom in/out. -1, 0 or 1 for each; all zero
   * stops. A camera keeps moving until it is told to stop.
   */
  z.object({
    type: z.literal('camera_move'),
    pan: z.number().int().min(-1).max(1),
    tilt: z.number().int().min(-1).max(1),
    zoom: z.number().int().min(-1).max(1),
  }),
  /** Displays: blank the picture (or bring it back) without powering off. */
  z.object({ type: z.literal('blank'), on: z.boolean() }),
  /**
   * Set a control point of a DSP or similar device. A level is 0 to 100 (the driver scales it to
   * the range of the point), a mute is true or false, a selector is a number.
   */
  z.object({
    type: z.literal('point'),
    pointId: LocalId,
    value: z.union([z.number(), z.boolean(), z.string().max(200)]),
  }),
  /** Displays: press a remote key. */
  z.object({ type: z.literal('key'), key: DisplayKey }),
  /** Displays: launch an app by its id from the device's app list. */
  z.object({ type: z.literal('launch_app'), appId: z.string().min(1).max(200) }),
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
  /** Displays: is the picture blanked (shutter, AV mute). */
  blanked: z.boolean().optional(),
  recording: z.boolean().optional(),
  /** Point-based devices: the last value of each control point, by point id (a level as 0 to 100). */
  points: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).default({}),
  /** Smart displays: the id of the app last launched. */
  activeApp: z.string().optional(),
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
  /** The quick actions this device's driver supports. Absent means none. */
  quickActions?(deviceId: string): QuickActionId[];
  /** The optional features of this device's driver class that its driver supports (see driver-classes). Absent means none. */
  features?(deviceId: string): string[];
  /** Read one control point from the device, to check it exists and learn its range. Rejects if it cannot. */
  readPoint?(deviceId: string, point: Pick<ControlPoint, 'type' | 'address' | 'min' | 'max'>): Promise<PointReading>;
}

export const defaultDeviceState = (): DeviceState => ({ online: true, routes: {}, signal: {}, points: {} });
