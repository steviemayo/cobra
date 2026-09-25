import { z } from 'zod';
import { LocalId } from '../room/common';
import { ActivityKind } from '../room/behaviour';
import { PanelSettings } from '../room/room-model';

// Panels send intents, never device commands. Validated at the gateway boundary.
export const PanelIntent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('activity.start'),
    activityId: LocalId,
    sourceId: LocalId.optional(),
  }),
  /** Stops an overlay activity such as Record. Primary activities end by starting Room Off. */
  z.object({ type: z.literal('activity.stop'), activityId: LocalId }),
  z.object({ type: z.literal('volume.set'), level: z.number().int().min(0).max(100) }),
  z.object({ type: z.literal('volume.bump'), delta: z.number().int().min(-25).max(25) }),
  z.object({ type: z.literal('mute.set'), muted: z.boolean() }),
  z.object({ type: z.literal('prompt.respond'), promptId: z.string().min(1), accept: z.boolean() }),
  /** "Stay on" during the auto-off warning. */
  z.object({ type: z.literal('warning.dismiss') }),
  /** A quick action from the bottom bar (Blank Screen, Privacy Mute). `active` is the wanted state for toggles. */
  z.object({
    type: z.literal('quickaction.run'),
    id: z.string().min(1),
    active: z.boolean().optional(),
  }),
  /** Run the room's On state ("Touch to begin" set to turn the room on). */
  z.object({ type: z.literal('room.on') }),
  /** Open or close a movable wall from the Room linking menu. Ids come from `linking.dividers`. */
  z.object({
    type: z.literal('divider.set'),
    dividerId: z.string().min(1).max(64),
    open: z.boolean(),
  }),
]);
export type PanelIntent = z.infer<typeof PanelIntent>;

// Plain-language messages are keys + params so panels can translate them.
export const MessageKey = z.enum([
  'ready',
  'starting',
  'stopping',
  'room_off',
  'presenting',
  'plug_in_source',
  'recording',
  'recording_saved',
  'fault_device',
  'fault_generic',
  'switch_source',
  'auto_off',
]);
export type MessageKey = z.infer<typeof MessageKey>;

export const PanelText = z.object({
  key: MessageKey,
  params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
});
export type PanelText = z.infer<typeof PanelText>;

export const MessageTone = z.enum(['info', 'progress', 'success', 'warn', 'error']);

export const RoomStatus = z.enum(['off', 'starting', 'on', 'stopping', 'fault']);
export type RoomStatus = z.infer<typeof RoomStatus>;

export const PanelSource = z.object({
  id: LocalId,
  label: z.string(),
  /** null = this room cannot tell whether a cable is plugged in. */
  present: z.boolean().nullable(),
  selected: z.boolean(),
});
export type PanelSource = z.infer<typeof PanelSource>;

export const PanelActivity = z.object({
  id: LocalId,
  name: z.string(),
  icon: z.string().optional(),
  kind: ActivityKind,
  sources: z.array(PanelSource),
  active: z.boolean(),
  /** Being started right now. */
  busy: z.boolean(),
  /** Runs alongside another activity (Record) instead of replacing it. */
  overlay: z.boolean(),
});
export type PanelActivity = z.infer<typeof PanelActivity>;

/** A one-tap action from a driver, such as Blank Screen. Shown in the panel's bottom bar. */
export const PanelQuickAction = z.object({
  id: z.string().min(1),
  label: z.string(),
  icon: z.string().optional(),
  /** toggle: has an on/off state. button: one shot. */
  kind: z.enum(['toggle', 'button']),
  active: z.boolean(),
});
export type PanelQuickAction = z.infer<typeof PanelQuickAction>;

/** One way to link rooms, as the "Link rooms" menu shows it: one per movable wall. */
export const PanelDivider = z.object({
  id: z.string().min(1).max(64),
  name: z.string(),
  /** true: the rooms it joins are linked now. */
  open: z.boolean(),
  /** All the rooms this wall joins, by name. */
  rooms: z.array(z.string()),
  /** The rooms linking would add to this panel's space ("Combine with ..."). Empty if all are in it already. */
  adds: z.array(z.string()),
  /** false: opening it now would join rooms that are not all running here yet. Closing is always possible. */
  available: z.boolean(),
});
export type PanelDivider = z.infer<typeof PanelDivider>;

/** Present only for rooms in a room group. */
export const PanelLinking = z.object({
  /** The walls that touch the space this panel controls, whether open or closed. */
  dividers: z.array(PanelDivider),
  /** The rooms joined into this space right now, by name. Just this room when nothing is open. */
  space: z.array(z.string()),
});
export type PanelLinking = z.infer<typeof PanelLinking>;

export const PanelViewModel = z.object({
  roomName: z.string(),
  status: RoomStatus,
  activities: z.array(PanelActivity),
  volume: z.object({
    available: z.boolean(),
    level: z.number(),
    muted: z.boolean(),
    /** false: no device reports its level, so panels should not show a number. Absent means true. */
    feedback: z.boolean().optional(),
  }),
  quickActions: z.array(PanelQuickAction).optional(),
  /** Panel look and behaviour from the room's settings. Absent means defaults. */
  ui: PanelSettings.optional(),
  message: z.object({ text: PanelText, tone: MessageTone }).nullable(),
  /** e.g. "Switch to Laptop 2?", auto-accepts when secondsLeft reaches 0. */
  prompt: z
    .object({ id: z.string(), text: PanelText, secondsLeft: z.number().nullable() })
    .nullable(),
  /** e.g. "Turning the room off in 30s". */
  warning: z.object({ text: PanelText, secondsLeft: z.number() }).nullable(),
  /** Present only for rooms in a room group: the walls and what is joined. */
  linking: PanelLinking.optional(),
});
export type PanelViewModel = z.infer<typeof PanelViewModel>;

/** Anything a panel can be bound to: the local runtime in the simulator, a WebSocket to the gateway later. */
export interface PanelClient {
  getSnapshot(): PanelViewModel;
  subscribe(listener: () => void): () => void;
  dispatch(intent: PanelIntent): void;
}
