import { z } from 'zod';
import { RoomType } from '../enums';
import { Activity, Group, RoomState, Trigger } from './behaviour';
import { Connection, Device } from './device';

export const ROOM_MODEL_SCHEMA_VERSION = 1;

export const RoomSettings = z.object({
  /** Default volume 0-100 unless overridden. */
  defaultVolume: z.number().int().min(0).max(100).default(50),
  autoOff: z
    .object({
      enabled: z.boolean().default(true),
      warnSeconds: z.number().int().min(0).max(600).default(30),
    })
    .default({ enabled: true, warnSeconds: 30 }),
  /** Seconds before auto-switching when a second source appears mid-activity. */
  sourceConflictSeconds: z.number().int().min(0).max(120).default(10),
  /** Extras exposed to users (lights/blinds/camera) only if enabled. */
  userControls: z
    .object({
      lights: z.boolean().default(false),
      blinds: z.boolean().default(false),
      camera: z.boolean().default(false),
    })
    .default({ lights: false, blinds: false, camera: false }),
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
