import { z } from 'zod';
import { RoomType } from '../enums';
import { Activity, Group, RoomState, Trigger } from './behaviour';
import { LocalId } from './common';
import { Connection, Device } from './device';

export const ROOM_MODEL_SCHEMA_VERSION = 1;

/** What "Touch to begin" does. wake: just open the panel. activity: start one. on: run the room's On state. */
export const IdleAction = z.enum(['wake', 'activity', 'on']);
export type IdleAction = z.infer<typeof IdleAction>;

export const IdleSettings = z.object({
  action: IdleAction.default('wake'),
  /** For action "activity": which one. Falls back to the first non-Off activity. */
  activityId: LocalId.optional(),
  /** Minutes without a touch before the panel goes back to "Touch to begin". 0 = never show it. */
  timeoutMinutes: z.number().int().min(0).max(240).default(0),
  /** Shown on the idle screen, e.g. how to reach the service desk. */
  supportText: z.string().max(200).optional(),
  /** Shown as a QR code on the idle screen. */
  supportUrl: z.string().url().optional(),
});
export type IdleSettings = z.infer<typeof IdleSettings>;

export const PanelSettings = z.object({
  idle: IdleSettings.default(() => IdleSettings.parse({})),
});
export type PanelSettings = z.infer<typeof PanelSettings>;

export const RoomSettings = z.object({
  /** Default volume 0-100 unless overridden. */
  defaultVolume: z.number().int().min(0).max(100).default(50),
  autoOff: z
    .object({
      enabled: z.boolean().default(true),
      /** Countdown shown before the room turns itself off. */
      warnSeconds: z.number().int().min(0).max(600).default(30),
      /** How long with no signal before the countdown starts. */
      idleSeconds: z.number().int().min(10).max(7200).default(600),
    })
    .default({ enabled: true, warnSeconds: 30, idleSeconds: 600 }),
  /** Seconds before auto-switching when a second source appears mid-activity. */
  sourceConflictSeconds: z.number().int().min(0).max(120).default(10),
  /** Extras exposed to users (lights, blinds and screens, camera, microphones) only if enabled. */
  userControls: z
    .object({
      lights: z.boolean().default(false),
      blinds: z.boolean().default(false),
      camera: z.boolean().default(false),
      microphones: z.boolean().default(false),
    })
    .default({ lights: false, blinds: false, camera: false, microphones: false }),
  /** How the generated panel looks and behaves. */
  panel: PanelSettings.default(() => PanelSettings.parse({})),
});
export type RoomSettings = z.infer<typeof RoomSettings>;

export const RoomModel = z.object({
  schemaVersion: z.literal(ROOM_MODEL_SCHEMA_VERSION).default(ROOM_MODEL_SCHEMA_VERSION),
  roomType: RoomType,
  settings: RoomSettings.default(() => RoomSettings.parse({})),
  devices: z.array(Device).default([]),
  connections: z.array(Connection).default([]),
  groups: z.array(Group).default([]),
  states: z.array(RoomState).default([]),
  activities: z.array(Activity).default([]),
  triggers: z.array(Trigger).default([]),
});
export type RoomModel = z.infer<typeof RoomModel>;
