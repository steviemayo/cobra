import { z } from 'zod';
import { DisplayKey, LocalId } from '../room/common';
import { ActivityKind } from '../room/behaviour';
import { PanelSettings } from '../room/room-model';

/** What the "room controls" page can tell blinds, a screen or a lifter to do. */
export const MoverAction = z.enum(['open', 'close', 'up', 'down']);
export type MoverAction = z.infer<typeof MoverAction>;

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
  /** Recall a camera preset. Ids and names come from `functions.cameras`. */
  z.object({
    type: z.literal('camera.preset'),
    deviceId: LocalId,
    preset: z.string().min(1).max(80),
  }),
  /** Point a camera. Sent again every half second while a button is held; all zero stops it. */
  z.object({
    type: z.literal('camera.move'),
    deviceId: LocalId,
    pan: z.number().int().min(-1).max(1),
    tilt: z.number().int().min(-1).max(1),
    zoom: z.number().int().min(-1).max(1),
  }),
  /** Press a remote key on a smart display. Sent again every half second while an arrow is held. */
  z.object({ type: z.literal('display.key'), deviceId: LocalId, key: DisplayKey }),
  /** Launch an app on a smart display. Ids come from `functions.displays`. */
  z.object({ type: z.literal('display.app'), deviceId: LocalId, appId: z.string().min(1).max(200) }),
  /** Nudge one reinforcement microphone's volume. Sent again while a button is held. */
  z.object({ type: z.literal('mic.bump'), deviceId: LocalId, delta: z.number().int().min(-25).max(25) }),
  /** Mute or unmute one microphone. */
  z.object({ type: z.literal('mic.mute'), deviceId: LocalId, muted: z.boolean() }),
  /** Recall a lighting scene. */
  z.object({ type: z.literal('scene.set'), deviceId: LocalId, scene: z.string().min(1).max(80) }),
  /** Move blinds, a screen or a lifter. */
  z.object({ type: z.literal('mover.run'), deviceId: LocalId, action: MoverAction }),
  /** Open or close a movable wall from the Room linking menu. Ids come from `linking.dividers`. */
  z.object({
    type: z.literal('divider.set'),
    dividerId: z.string().min(1).max(64),
    open: z.boolean(),
  }),
]);
export type PanelIntent = z.infer<typeof PanelIntent>;

/** Physical things a panel can move. Shared so anywhere an intent is accepted can treat these the same. */
export const ACTUATOR_INTENTS: ReadonlySet<string> = new Set(['divider.set', 'mover.run']);

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

/** A camera with what a person can do to it. */
export const PanelCamera = z.object({
  id: LocalId,
  name: z.string(),
  presets: z.array(z.string()),
  /** The preset last recalled, if the camera says. */
  activePreset: z.string().nullable(),
  /** Pan, tilt and zoom are available. */
  canMove: z.boolean(),
});
export type PanelCamera = z.infer<typeof PanelCamera>;

export const PanelMic = z.object({
  id: LocalId,
  name: z.string(),
  /** null: the microphone does not say. */
  muted: z.boolean().nullable(),
  /** The volume buttons work (the driver declares volume). */
  canVolume: z.boolean().default(false),
  /** 0 to 100, only when the microphone reports its level. */
  volume: z.number().min(0).max(100).nullable().default(null),
});
export type PanelMic = z.infer<typeof PanelMic>;

export const PanelLight = z.object({
  id: LocalId,
  name: z.string(),
  scenes: z.array(z.string()),
  active: z.string().nullable(),
});
export type PanelLight = z.infer<typeof PanelLight>;

export const PanelMover = z.object({
  id: LocalId,
  name: z.string(),
  kind: z.enum(['blinds', 'screen', 'lifter']),
  actions: z.array(MoverAction),
});
export type PanelMover = z.infer<typeof PanelMover>;

/** A smart display and what its driver lets a person do to it. */
export const PanelDisplay = z.object({
  id: LocalId,
  name: z.string(),
  /** Arrows, OK, Back, Home and Menu. */
  keys: z.boolean(),
  /** Play, pause, stop, forward and rewind. */
  media: z.boolean(),
  apps: z.array(z.object({ id: z.string(), name: z.string() })),
  /** The app last launched, if known. */
  activeApp: z.string().nullable(),
});
export type PanelDisplay = z.infer<typeof PanelDisplay>;

/** The pages behind the top nav. A page is offered only if the room has the equipment and enables it. */
export const PanelFunctions = z.object({
  cameras: z.array(PanelCamera),
  microphones: z.array(PanelMic),
  lights: z.array(PanelLight),
  movers: z.array(PanelMover),
  displays: z.array(PanelDisplay).default([]),
});
export type PanelFunctions = z.infer<typeof PanelFunctions>;

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
  /** Camera, microphone, lighting and blinds pages. Absent when the room offers none. */
  functions: PanelFunctions.optional(),
});
export type PanelViewModel = z.infer<typeof PanelViewModel>;

/** Anything a panel can be bound to: the local runtime in the simulator, a WebSocket to the gateway later. */
export interface PanelClient {
  getSnapshot(): PanelViewModel;
  subscribe(listener: () => void): () => void;
  dispatch(intent: PanelIntent): void;
}
