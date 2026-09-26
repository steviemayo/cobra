import type { RoomType } from '../enums';
import { DEVICE_CATALOG, type DeviceCategory } from './catalog';
import { ACTIVITY_DEFAULTS, ROOM_TYPES } from './room-types';
import { RoomModel } from './room-model';

/** Blank model for a room type: type defaults applied, no devices. */
export function newRoomModel(roomType: RoomType): RoomModel {
  return RoomModel.parse({ roomType, settings: ROOM_TYPES[roomType].settings });
}

/** Device with the category's default ports and capabilities applied. */
export function deviceFromCategory(category: DeviceCategory, id: string, name: string) {
  return {
    id,
    name,
    category,
    ports: DEVICE_CATALOG[category].defaultPorts.map((p) => ({ ...p })),
  };
}

export interface StarterTemplate {
  id: string;
  name: string;
  description: string;
  roomType: RoomType;
  model: RoomModel;
}

/** The "90% room": 2 laptop inputs -> matrix -> 2 displays + DSP + speakers. */
const meetingTwoLaptops = RoomModel.parse({
  roomType: 'meeting',
  settings: ROOM_TYPES.meeting.settings,
  devices: [
    deviceFromCategory('video_source', 'laptop1', 'Laptop 1'),
    deviceFromCategory('video_source', 'laptop2', 'Laptop 2'),
    {
      id: 'matrix',
      name: 'Video matrix',
      category: 'video_matrix',
      control: { kind: 'driver', driverId: 'crestron-dm-nvx' },
      ports: [
        { id: 'in1', name: 'Input 1', direction: 'in', signal: 'av' },
        { id: 'in2', name: 'Input 2', direction: 'in', signal: 'av' },
        { id: 'out1', name: 'Output 1', direction: 'out', signal: 'av' },
        { id: 'out2', name: 'Output 2', direction: 'out', signal: 'av' },
        { id: 'out3', name: 'Audio out', direction: 'out', signal: 'audio' },
      ],
    },
    {
      ...deviceFromCategory('display', 'display1', 'Display 1'),
      control: { kind: 'generic', protocol: 'pjlink' },
    },
    {
      ...deviceFromCategory('display', 'display2', 'Display 2'),
      control: { kind: 'generic', protocol: 'pjlink' },
    },
    {
      id: 'dsp',
      name: 'DSP',
      category: 'audio_matrix',
      control: { kind: 'driver', driverId: 'qsys-core' },
      settings: { gainComponent: 'gain' },
      ports: [
        { id: 'in', name: 'Input', direction: 'in', signal: 'audio' },
        { id: 'out', name: 'Output', direction: 'out', signal: 'audio' },
      ],
    },
    deviceFromCategory('audio_destination', 'speakers', 'Speakers'),
  ],
  connections: [
    {
      id: 'c1',
      from: { deviceId: 'laptop1', portId: 'out' },
      to: { deviceId: 'matrix', portId: 'in1' },
    },
    {
      id: 'c2',
      from: { deviceId: 'laptop2', portId: 'out' },
      to: { deviceId: 'matrix', portId: 'in2' },
    },
    {
      id: 'c3',
      from: { deviceId: 'matrix', portId: 'out1' },
      to: { deviceId: 'display1', portId: 'in' },
    },
    {
      id: 'c4',
      from: { deviceId: 'matrix', portId: 'out2' },
      to: { deviceId: 'display2', portId: 'in' },
    },
    {
      id: 'c5',
      from: { deviceId: 'matrix', portId: 'out3' },
      to: { deviceId: 'dsp', portId: 'in' },
    },
    {
      id: 'c6',
      from: { deviceId: 'dsp', portId: 'out' },
      to: { deviceId: 'speakers', portId: 'in' },
    },
  ],
  groups: [
    {
      id: 'displays',
      name: 'Displays',
      kind: 'display',
      members: ['display1', 'display2'],
      allowedSources: ['laptop1', 'laptop2'],
      mode: 'follow',
    },
  ],
  states: [
    {
      id: 'off',
      name: 'Off',
      kind: 'off',
      actions: [
        { id: 'a1', type: 'power', deviceId: 'display1', on: false },
        { id: 'a2', type: 'power', deviceId: 'display2', on: false },
        { id: 'a3', type: 'mute', deviceId: 'dsp', muted: true },
      ],
    },
    {
      id: 'on',
      name: 'On',
      kind: 'on',
      actions: [
        { id: 'a1', type: 'power', deviceId: 'display1', on: true },
        { id: 'a2', type: 'power', deviceId: 'display2', on: true },
        { id: 'a3', type: 'mute', deviceId: 'dsp', muted: false },
        { id: 'a4', type: 'volume', deviceId: 'dsp', level: 50, dependsOn: ['a3'] },
      ],
    },
  ],
  activities: [
    {
      id: 'present',
      ...ACTIVITY_DEFAULTS.present,
      kind: 'present',
      sources: [
        { id: 'laptop1', label: 'Laptop 1', deviceId: 'laptop1' },
        { id: 'laptop2', label: 'Laptop 2', deviceId: 'laptop2' },
      ],
      targetGroupId: 'displays',
      actions: [{ id: 'a1', type: 'run_state', stateId: 'on' }],
    },
    {
      id: 'room_off',
      ...ACTIVITY_DEFAULTS.room_off,
      kind: 'room_off',
      actions: [{ id: 'a1', type: 'run_state', stateId: 'off' }],
    },
  ],
  triggers: [
    {
      id: 't1',
      type: 'signal_detect',
      name: 'Laptop 1 plugged in',
      deviceId: 'laptop1',
      run: { type: 'activity', activityId: 'present', sourceId: 'laptop1' },
    },
    {
      id: 't2',
      type: 'signal_detect',
      name: 'Laptop 2 plugged in',
      deviceId: 'laptop2',
      run: { type: 'activity', activityId: 'present', sourceId: 'laptop2' },
    },
  ],
});

/** Training room: presenter laptops plus a PTZ camera, recorded through a matrix output. */
const trainingRecorded = RoomModel.parse({
  roomType: 'training',
  settings: ROOM_TYPES.training.settings,
  devices: [
    deviceFromCategory('video_source', 'laptop1', 'Presenter laptop'),
    deviceFromCategory('video_source', 'laptop2', 'Guest laptop'),
    {
      ...deviceFromCategory('ptz_camera', 'camera', 'Lectern camera'),
      control: { kind: 'generic', protocol: 'tcp' },
    },
    {
      id: 'matrix',
      name: 'Video matrix',
      category: 'video_matrix',
      control: { kind: 'driver', driverId: 'crestron-dm-nvx' },
      ports: [
        { id: 'in1', name: 'Input 1', direction: 'in', signal: 'av' },
        { id: 'in2', name: 'Input 2', direction: 'in', signal: 'av' },
        { id: 'in3', name: 'Input 3', direction: 'in', signal: 'av' },
        { id: 'out1', name: 'Output 1', direction: 'out', signal: 'av' },
        { id: 'out2', name: 'Output 2', direction: 'out', signal: 'av' },
        { id: 'out3', name: 'Audio out', direction: 'out', signal: 'audio' },
        { id: 'out4', name: 'Recorder out', direction: 'out', signal: 'av' },
      ],
    },
    {
      ...deviceFromCategory('display', 'display1', 'Front display'),
      control: { kind: 'generic', protocol: 'pjlink' },
    },
    {
      ...deviceFromCategory('display', 'display2', 'Side display'),
      control: { kind: 'generic', protocol: 'pjlink' },
    },
    {
      id: 'dsp',
      name: 'DSP',
      category: 'audio_matrix',
      control: { kind: 'driver', driverId: 'qsys-core' },
      settings: { gainComponent: 'gain' },
      ports: [
        { id: 'in', name: 'Input', direction: 'in', signal: 'audio' },
        { id: 'out', name: 'Output', direction: 'out', signal: 'audio' },
      ],
    },
    deviceFromCategory('audio_destination', 'speakers', 'Speakers'),
    {
      ...deviceFromCategory('recorder', 'recorder', 'Lecture recorder'),
      control: { kind: 'generic', protocol: 'rest' },
    },
  ],
  connections: [
    {
      id: 'c1',
      from: { deviceId: 'laptop1', portId: 'out' },
      to: { deviceId: 'matrix', portId: 'in1' },
    },
    {
      id: 'c2',
      from: { deviceId: 'laptop2', portId: 'out' },
      to: { deviceId: 'matrix', portId: 'in2' },
    },
    {
      id: 'c3',
      from: { deviceId: 'camera', portId: 'out' },
      to: { deviceId: 'matrix', portId: 'in3' },
    },
    {
      id: 'c4',
      from: { deviceId: 'matrix', portId: 'out1' },
      to: { deviceId: 'display1', portId: 'in' },
    },
    {
      id: 'c5',
      from: { deviceId: 'matrix', portId: 'out2' },
      to: { deviceId: 'display2', portId: 'in' },
    },
    {
      id: 'c6',
      from: { deviceId: 'matrix', portId: 'out3' },
      to: { deviceId: 'dsp', portId: 'in' },
    },
    {
      id: 'c7',
      from: { deviceId: 'dsp', portId: 'out' },
      to: { deviceId: 'speakers', portId: 'in' },
    },
    {
      id: 'c8',
      from: { deviceId: 'matrix', portId: 'out4' },
      to: { deviceId: 'recorder', portId: 'in' },
    },
  ],
  groups: [
    {
      id: 'displays',
      name: 'Displays',
      kind: 'display',
      members: ['display1', 'display2'],
      allowedSources: ['laptop1', 'laptop2'],
      mode: 'follow',
    },
  ],
  states: [
    {
      id: 'off',
      name: 'Off',
      kind: 'off',
      actions: [
        { id: 'a1', type: 'power', deviceId: 'display1', on: false },
        { id: 'a2', type: 'power', deviceId: 'display2', on: false },
        { id: 'a3', type: 'mute', deviceId: 'dsp', muted: true },
      ],
    },
    {
      id: 'on',
      name: 'On',
      kind: 'on',
      actions: [
        { id: 'a1', type: 'power', deviceId: 'display1', on: true },
        { id: 'a2', type: 'power', deviceId: 'display2', on: true },
        { id: 'a3', type: 'mute', deviceId: 'dsp', muted: false },
        { id: 'a4', type: 'volume', deviceId: 'dsp', level: 50, dependsOn: ['a3'] },
      ],
    },
  ],
  activities: [
    {
      id: 'present',
      ...ACTIVITY_DEFAULTS.present,
      kind: 'present',
      sources: [
        { id: 'laptop1', label: 'Presenter laptop', deviceId: 'laptop1' },
        { id: 'laptop2', label: 'Guest laptop', deviceId: 'laptop2' },
      ],
      targetGroupId: 'displays',
      actions: [{ id: 'a1', type: 'run_state', stateId: 'on' }],
    },
    {
      id: 'record',
      ...ACTIVITY_DEFAULTS.record,
      kind: 'record',
      actions: [
        { id: 'a1', type: 'camera_preset', deviceId: 'camera', preset: 'lectern' },
        {
          id: 'a2',
          type: 'device_command',
          deviceId: 'recorder',
          command: 'record',
          args: { on: true },
        },
      ],
    },
    {
      id: 'room_off',
      ...ACTIVITY_DEFAULTS.room_off,
      kind: 'room_off',
      actions: [{ id: 'a1', type: 'run_state', stateId: 'off' }],
    },
  ],
  triggers: [
    {
      id: 't1',
      type: 'signal_detect',
      name: 'Presenter laptop plugged in',
      deviceId: 'laptop1',
      run: { type: 'activity', activityId: 'present', sourceId: 'laptop1' },
    },
    {
      id: 't2',
      type: 'signal_detect',
      name: 'Guest laptop plugged in',
      deviceId: 'laptop2',
      run: { type: 'activity', activityId: 'present', sourceId: 'laptop2' },
    },
  ],
});

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    id: 'meeting-2-laptops',
    name: 'Meeting room — 2 laptops, 2 displays, DSP',
    description:
      'Two laptop inputs through a matrix to two displays, with DSP-controlled speakers.',
    roomType: 'meeting',
    model: meetingTwoLaptops,
  },
  {
    id: 'training-recorded',
    name: 'Training room — 2 laptops, camera, recorder',
    description:
      'Presenter and guest laptops plus a lectern camera, with a Record activity and a recorder fed from the matrix.',
    roomType: 'training',
    model: trainingRecorded,
  },
  {
    id: 'meeting-blank',
    name: 'Meeting room — blank',
    description: 'Empty meeting room with type defaults.',
    roomType: 'meeting',
    model: newRoomModel('meeting'),
  },
  {
    id: 'training-blank',
    name: 'Training room — blank',
    description: 'Empty training room with type defaults.',
    roomType: 'training',
    model: newRoomModel('training'),
  },
];
