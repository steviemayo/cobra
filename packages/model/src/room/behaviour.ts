import { z } from 'zod';
import { Action } from './action';
import { Capability, LocalId } from './common';

export const GroupMode = z.enum(['follow', 'independent']);
export type GroupMode = z.infer<typeof GroupMode>;

export const Group = z.object({
  id: LocalId,
  name: z.string().min(1).max(80),
  kind: z.enum(['display', 'audio']),
  members: z.array(LocalId).default([]),
  /** Device ids allowed to be selected as a source for this group. */
  allowedSources: z.array(LocalId).default([]),
  mode: GroupMode.default('follow'),
});
export type Group = z.infer<typeof Group>;

export const StateKind = z.enum(['off', 'on', 'custom']);
export type StateKind = z.infer<typeof StateKind>;

export const RoomState = z.object({
  id: LocalId,
  name: z.string().min(1).max(80),
  kind: StateKind,
  actions: z.array(Action).default([]),
});
export type RoomState = z.infer<typeof RoomState>;

export const ActivityKind = z.enum(['present', 'video_call', 'record', 'room_off', 'custom']);
export type ActivityKind = z.infer<typeof ActivityKind>;

export const ActivitySource = z.object({
  id: LocalId,
  /** Plain-language label shown to users, e.g. "Laptop 1". */
  label: z.string().min(1).max(60),
  deviceId: LocalId,
  portId: LocalId.optional(),
});
export type ActivitySource = z.infer<typeof ActivitySource>;

export const Activity = z.object({
  id: LocalId,
  /** User-facing intent name, never a device function. */
  name: z.string().min(1).max(60),
  kind: ActivityKind,
  icon: z.string().max(40).optional(),
  hidden: z.boolean().default(false),
  /** Only offered when every capability exists somewhere in the room. */
  requires: z.array(Capability).default([]),
  sources: z.array(ActivitySource).default([]),
  /** Group whose displays the chosen source is routed to. */
  targetGroupId: LocalId.optional(),
  actions: z.array(Action).default([]),
});
export type Activity = z.infer<typeof Activity>;

export const TriggerTarget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('activity'), activityId: LocalId, sourceId: LocalId.optional() }),
  z.object({ type: z.literal('state'), stateId: LocalId }),
]);
export type TriggerTarget = z.infer<typeof TriggerTarget>;

const triggerBase = {
  id: LocalId,
  name: z.string().min(1).max(80),
  enabled: z.boolean().default(true),
  run: TriggerTarget,
};

export const Trigger = z.discriminatedUnion('type', [
  z.object({ ...triggerBase, type: z.literal('tap') }),
  z.object({
    ...triggerBase,
    type: z.literal('signal_detect'),
    deviceId: LocalId,
    portId: LocalId.optional(),
  }),
  z.object({
    ...triggerBase,
    type: z.literal('schedule'),
    cron: z.string().min(1),
    timezone: z.string().min(1).default('UTC'),
  }),
  z.object({
    ...triggerBase,
    type: z.literal('occupancy'),
    deviceId: LocalId,
    occupied: z.boolean(),
  }),
  z.object({
    ...triggerBase,
    type: z.literal('calendar'),
    provider: z.enum(['graph', 'google']),
    resourceId: z.string().min(1),
  }),
  z.object({ ...triggerBase, type: z.literal('webhook'), hookName: LocalId }),
]);
export type Trigger = z.infer<typeof Trigger>;
export type TriggerType = Trigger['type'];

export const RoomCombination = z.object({
  id: LocalId,
  name: z.string().min(1).max(80),
  /** Kestrel Room record ids (database ids, not model-local ids). */
  primaryRoomId: z.string().min(1),
  secondaryRoomIds: z.array(z.string().min(1)).min(1),
  secondaryVideo: z.enum(['follow', 'blank']).default('follow'),
  secondaryAudio: z.enum(['follow', 'blank']).default('follow'),
  onUncombine: z.literal('off').default('off'),
});
export type RoomCombination = z.infer<typeof RoomCombination>;
