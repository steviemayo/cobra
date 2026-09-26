import { z } from 'zod';

export const LocalId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'letters, numbers, - and _ only');
export type LocalId = z.infer<typeof LocalId>;

/** A remote-control key a display can be sent: navigation, then media. Which a display takes depends on its driver's features. */
export const DisplayKey = z.enum([
  'up',
  'down',
  'left',
  'right',
  'ok',
  'back',
  'home',
  'menu',
  'play',
  'pause',
  'stop',
  'forward',
  'rewind',
]);
export type DisplayKey = z.infer<typeof DisplayKey>;
export const NAVIGATION_KEYS: DisplayKey[] = ['up', 'down', 'left', 'right', 'ok', 'back', 'home', 'menu'];
export const MEDIA_KEYS: DisplayKey[] = ['play', 'pause', 'stop', 'forward', 'rewind'];

export const SignalKind = z.enum(['video', 'audio', 'av']);
export type SignalKind = z.infer<typeof SignalKind>;

export const PortDirection = z.enum(['in', 'out']);
export type PortDirection = z.infer<typeof PortDirection>;

export const Capability = z.enum([
  'video_source',
  'audio_source',
  'video_sink',
  'audio_sink',
  'video_route',
  'audio_route',
  'power',
  'volume',
  'mute',
  'preset',
  'signal_detect',
  'camera_preset',
  'record',
  'conference',
  'lighting',
  'blinds',
  'hvac',
  'mechanical',
  'occupancy',
]);
export type Capability = z.infer<typeof Capability>;

export const PortRef = z.object({ deviceId: LocalId, portId: LocalId });
export type PortRef = z.infer<typeof PortRef>;

export function signalCarries(signal: SignalKind, wanted: 'video' | 'audio'): boolean {
  return signal === 'av' || signal === wanted;
}
