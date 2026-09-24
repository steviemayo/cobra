import { z } from 'zod';
import { LocalId } from './common';

const base = {
  id: LocalId,
  /** Action ids that must finish first. No dependencies = runs in parallel with the rest. */
  dependsOn: z.array(LocalId).default([]),
};

export const Action = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('power'), deviceId: LocalId, on: z.boolean() }),
  z.object({
    ...base,
    type: z.literal('route'),
    /** End-to-end: the engine resolves the path through matrices. */
    sourceDeviceId: LocalId,
    sourcePortId: LocalId.optional(),
    destinationDeviceId: LocalId,
    destinationPortId: LocalId.optional(),
  }),
  z.object({ ...base, type: z.literal('preset'), deviceId: LocalId, preset: z.string().min(1) }),
  z.object({
    ...base,
    type: z.literal('camera_preset'),
    deviceId: LocalId,
    preset: z.string().min(1),
  }),
  z.object({ ...base, type: z.literal('mute'), deviceId: LocalId, muted: z.boolean() }),
  z.object({
    ...base,
    type: z.literal('volume'),
    deviceId: LocalId,
    level: z.number().int().min(0).max(100),
  }),
  z.object({
    ...base,
    type: z.literal('device_command'),
    deviceId: LocalId,
    command: z.string().min(1),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({ ...base, type: z.literal('env_scene'), deviceId: LocalId, scene: z.string().min(1) }),
  z.object({ ...base, type: z.literal('run_state'), stateId: LocalId }),
]);
export type Action = z.infer<typeof Action>;
export type ActionType = Action['type'];
