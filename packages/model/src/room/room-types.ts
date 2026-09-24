import type { RoomType } from '../enums';
import type { ActivityKind } from './behaviour';
import type { Capability } from './common';
import { RoomSettings } from './room-model';

export interface RoomTypeInfo {
  label: string;
  description: string;
  /** Activities the generator proposes for this type (still filtered by room capabilities). */
  defaultActivities: ActivityKind[];
  settings: RoomSettings;
}

export const ACTIVITY_DEFAULTS: Record<
  Exclude<ActivityKind, 'custom'>,
  { name: string; icon: string; requires: Capability[] }
> = {
  present: { name: 'Present', icon: 'present', requires: ['video_source', 'video_sink'] },
  video_call: { name: 'Video Call', icon: 'video-call', requires: ['conference'] },
  record: { name: 'Record', icon: 'record', requires: ['record'] },
  room_off: { name: 'Room Off', icon: 'power', requires: [] },
};

export const ROOM_TYPES: Record<RoomType, RoomTypeInfo> = {
  meeting: {
    label: 'Meeting room',
    description: 'Laptop presentation and video calls.',
    defaultActivities: ['present', 'video_call', 'room_off'],
    settings: RoomSettings.parse({}),
  },
  training: {
    label: 'Training room',
    description: 'Presenter plus audience, with recording.',
    defaultActivities: ['present', 'video_call', 'record', 'room_off'],
    settings: RoomSettings.parse({}),
  },
};
