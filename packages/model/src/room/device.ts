import { z } from 'zod';
import { DeviceCategory } from './catalog';
import { Capability, LocalId, PortDirection, PortRef, SignalKind } from './common';
import { ControlPoint } from './points';

export const Port = z.object({
  id: LocalId,
  name: z.string().min(1).max(80),
  direction: PortDirection,
  signal: SignalKind,
});
export type Port = z.infer<typeof Port>;

export const GenericProtocol = z.enum(['tcp', 'serial', 'pjlink', 'rest']);
export type GenericProtocol = z.infer<typeof GenericProtocol>;

export const DeviceControl = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('driver'),
    driverId: z.string().min(1),
    driverVersion: z.string().optional(),
  }),
  z.object({ kind: z.literal('generic'), protocol: GenericProtocol }),
]);
export type DeviceControl = z.infer<typeof DeviceControl>;

/** What a reinforcement microphone does when the room turns on: unmute (the default), leave as it is, or mute. */
export const MicStart = z.enum(['unmute', 'leave', 'mute']);
export type MicStart = z.infer<typeof MicStart>;
/** What it does when the room turns off: mute (the default) or leave as it is. */
export const MicStop = z.enum(['mute', 'leave']);
export type MicStop = z.infer<typeof MicStop>;

/** How one reinforcement microphone appears and behaves. Everything is optional, so old rooms are valid. */
export const MicSettings = z.object({
  /** What the panel and phone page call it ("Lectern mic"), instead of the device name. */
  label: z.string().trim().min(1).max(60).optional(),
  /** Keep it off the panel while still controlling it from activities. */
  hidden: z.boolean().optional(),
  /** Lower numbers first. Microphones with none keep the order of the device list, after those with one. */
  order: z.number().int().min(0).max(999).optional(),
  onStart: MicStart.optional(),
  onStop: MicStop.optional(),
  /** Where the volume buttons start from when the microphone reports no level. Default 50. */
  defaultVolume: z.number().int().min(0).max(100).optional(),
});
export type MicSettings = z.infer<typeof MicSettings>;

export const Device = z.object({
  id: LocalId,
  name: z.string().min(1).max(80),
  category: DeviceCategory,
  ports: z.array(Port).default([]),
  /** Extra capabilities on top of the category defaults (e.g. a display that also reports signal). */
  extraCapabilities: z.array(Capability).default([]),
  control: DeviceControl.optional(),
  /** Free-form per-device settings (host, port, gain component name, ...). Interpreted by the driver. */
  settings: z.record(z.string(), z.unknown()).default({}),
  /** Only for reinforcement microphones (see MicSettings). */
  mic: MicSettings.optional(),
  /** Only for point-based devices (a DSP): the things inside it that Kestrel controls. */
  points: z.array(ControlPoint).max(200).optional(),
});
export type Device = z.infer<typeof Device>;

export const Connection = z.object({
  id: LocalId,
  from: PortRef,
  to: PortRef,
});
export type Connection = z.infer<typeof Connection>;
