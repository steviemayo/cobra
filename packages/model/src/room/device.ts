import { z } from 'zod';
import { DeviceCategory } from './catalog';
import { Capability, LocalId, PortDirection, PortRef, SignalKind } from './common';

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
});
export type Device = z.infer<typeof Device>;

export const Connection = z.object({
  id: LocalId,
  from: PortRef,
  to: PortRef,
});
export type Connection = z.infer<typeof Connection>;
