import { z } from 'zod';
import { LocalId } from './common';

// Control points (docs/driver-classes.md, "Point-based devices"): a DSP or similar open-architecture
// device is added first, then the things to control inside it (a gain block, a mute, a router) are
// added one by one. A point's address is written in the form its driver uses; a role connects it to
// the room (room volume, a microphone level) and so to activities and the panel.

export const POINT_TYPES = [
  'level',
  'mute',
  'select',
  'crosspoint',
  'preset',
  'meter',
  'generic',
] as const;
export const PointType = z.enum(POINT_TYPES);
export type PointType = z.infer<typeof PointType>;

export const POINT_TYPE_LABEL: Record<PointType, string> = {
  level: 'Level',
  mute: 'Mute',
  select: 'Selector',
  crosspoint: 'Crosspoint',
  preset: 'Preset or snapshot',
  meter: 'Meter (read only)',
  generic: 'Generic control',
};

/** What a point is for in the room. The ones wired up today; others (zone select, signal detect) come later. */
export const POINT_ROLES = [
  'room_volume',
  'room_mute',
  'mic_level',
  'mic_mute',
  'mic_privacy_mute',
] as const;
export const PointRole = z.enum(POINT_ROLES);
export type PointRole = z.infer<typeof PointRole>;

export const POINT_ROLE_INFO: Record<
  PointRole,
  { label: string; type: PointType; needsMic: boolean }
> = {
  room_volume: { label: 'Room volume', type: 'level', needsMic: false },
  room_mute: { label: 'Room mute', type: 'mute', needsMic: false },
  mic_level: { label: 'Reinforcement microphone level', type: 'level', needsMic: true },
  mic_mute: { label: 'Reinforcement microphone mute', type: 'mute', needsMic: true },
  mic_privacy_mute: { label: 'Conferencing microphone privacy mute', type: 'mute', needsMic: true },
};

/** Where a point lives on its device, in the form its driver uses (for Q-SYS a component and a control). */
export const PointAddress = z.record(
  z.string().min(1).max(40),
  z.union([z.string().max(200), z.number()]),
);
export type PointAddress = z.infer<typeof PointAddress>;

/**
 * What to watch a point for. It is checked against the value Kestrel reads: 0 to 100 for a level,
 * true or false for a mute, text for a select or a generic point. Set `expect` for a value the
 * point should hold (a mute that should be off, a status that should say OK), `min` and `max` for a
 * range. Leaving them all out watches nothing.
 */
export const PointWatch = z.object({
  expect: z.union([z.number(), z.boolean(), z.string().max(200)]).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** How serious it is when the point is out of bounds. */
  severity: z.enum(['info', 'warning', 'critical']).default('warning'),
});
export type PointWatch = z.infer<typeof PointWatch>;

export const ControlPoint = z.object({
  id: LocalId,
  name: z.string().trim().min(1).max(80),
  type: PointType,
  address: PointAddress.default({}),
  role: PointRole.optional(),
  /** The microphone a microphone role acts on. */
  targetId: LocalId.optional(),
  /** Level points: the own range of the device, shown as 0 to 100 on the panel (usually dB). */
  min: z.number().optional(),
  max: z.number().optional(),
  /** Watch this point and raise an incident when it is out of bounds. Works with or without control. */
  watch: PointWatch.optional(),
});
export type ControlPoint = z.infer<typeof ControlPoint>;

/** One part of a point address a driver asks for. */
export interface PointAddressField {
  key: string;
  label: string;
}
/** The address form for each point type a driver supports. A type left out is not supported. */
export type PointForms = Partial<Record<PointType, PointAddressField[]>>;

/** What a point read from the device says. `min` and `max` fill in the range of a level. */
export const PointReading = z.object({
  value: z.union([z.number(), z.boolean(), z.string()]),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type PointReading = z.infer<typeof PointReading>;

/** Points and their state values: 0 to 100 for a level, true or false for a mute. */
export type PointValue = number | boolean | string;

const DEFAULT_RANGE = { min: -40, max: 0 };

/** The level a person sees (0 to 100), from the native value of the device. */
export function pointToLevel(point: Pick<ControlPoint, 'min' | 'max'>, native: number): number {
  const min = point.min ?? DEFAULT_RANGE.min;
  const max = point.max ?? DEFAULT_RANGE.max;
  return max === min
    ? 0
    : Math.max(0, Math.min(100, Math.round(((native - min) / (max - min)) * 100)));
}

/** The native value for the device, from the 0 to 100 a person sets. Rounded to one decimal, as a dB value is. */
export function pointFromLevel(point: Pick<ControlPoint, 'min' | 'max'>, level: number): number {
  const min = point.min ?? DEFAULT_RANGE.min;
  const max = point.max ?? DEFAULT_RANGE.max;
  return Math.round((min + (level / 100) * (max - min)) * 10) / 10;
}

/** A watched point's reading: fine, or what is wrong with it in plain words. */
export type WatchResult = { ok: true } | { ok: false; message: string };

const show = (v: PointValue) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));

/**
 * Checks a reading against what the point is watched for. `name` is the point's name, used in the
 * message. A watch with nothing set is always fine.
 */
export function checkWatch(name: string, watch: PointWatch, value: PointValue): WatchResult {
  if (watch.expect !== undefined && value !== watch.expect)
    return { ok: false, message: `${name} is ${show(value)}, expected ${show(watch.expect)}` };
  if (typeof value === 'number') {
    if (watch.min !== undefined && value < watch.min)
      return { ok: false, message: `${name} is ${value}, below ${watch.min}` };
    if (watch.max !== undefined && value > watch.max)
      return { ok: false, message: `${name} is ${value}, above ${watch.max}` };
  }
  return { ok: true };
}
