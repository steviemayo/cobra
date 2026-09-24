import { z } from 'zod';
import { Capability, type PortDirection, type SignalKind } from './common';

export const DeviceCategory = z.enum([
  'video_source',
  'audio_source',
  'conf_camera',
  'fixed_camera',
  'ptz_camera',
  'autoframing_camera',
  'reinforcement_mic',
  'voice_capture_mic',
  'conference_system',
  'video_matrix',
  'audio_matrix',
  'video_destination',
  'audio_destination',
  'conference_output',
  'recorder',
  'lighting',
  'hvac',
  'blinds',
  'lifter',
  'screen',
]);
export type DeviceCategory = z.infer<typeof DeviceCategory>;

export interface PortTemplate {
  id: string;
  name: string;
  direction: PortDirection;
  signal: SignalKind;
}

export interface CategoryInfo {
  label: string;
  section: 'source' | 'camera' | 'mic' | 'conference' | 'matrix' | 'destination' | 'environment';
  capabilities: Capability[];
  /** Sources like a laptop input have nothing to control, so no driver is needed. */
  controllable: boolean;
  defaultPorts: PortTemplate[];
}

const out = (id: string, name: string, signal: SignalKind): PortTemplate => ({
  id,
  name,
  direction: 'out',
  signal,
});
const inp = (id: string, name: string, signal: SignalKind): PortTemplate => ({
  id,
  name,
  direction: 'in',
  signal,
});

export const DEVICE_CATALOG: Record<DeviceCategory, CategoryInfo> = {
  video_source: {
    label: 'Video source',
    section: 'source',
    capabilities: ['video_source', 'audio_source'],
    controllable: false,
    defaultPorts: [out('out', 'Output', 'av')],
  },
  audio_source: {
    label: 'Audio source',
    section: 'source',
    capabilities: ['audio_source'],
    controllable: false,
    defaultPorts: [out('out', 'Output', 'audio')],
  },
  conf_camera: {
    label: 'Conference camera',
    section: 'camera',
    capabilities: ['video_source'],
    controllable: true,
    defaultPorts: [out('out', 'Output', 'video')],
  },
  fixed_camera: {
    label: 'Fixed camera',
    section: 'camera',
    capabilities: ['video_source'],
    controllable: false,
    defaultPorts: [out('out', 'Output', 'video')],
  },
  ptz_camera: {
    label: 'PTZ camera',
    section: 'camera',
    capabilities: ['video_source', 'camera_preset'],
    controllable: true,
    defaultPorts: [out('out', 'Output', 'video')],
  },
  autoframing_camera: {
    label: 'Auto-framing camera',
    section: 'camera',
    capabilities: ['video_source', 'camera_preset'],
    controllable: true,
    defaultPorts: [out('out', 'Output', 'video')],
  },
  reinforcement_mic: {
    label: 'Reinforcement microphone',
    section: 'mic',
    capabilities: ['audio_source', 'mute'],
    controllable: false,
    defaultPorts: [out('out', 'Output', 'audio')],
  },
  voice_capture_mic: {
    label: 'Voice-capture microphone',
    section: 'mic',
    capabilities: ['audio_source', 'mute'],
    controllable: false,
    defaultPorts: [out('out', 'Output', 'audio')],
  },
  conference_system: {
    label: 'Conference system (MTR / codec)',
    section: 'conference',
    capabilities: ['conference', 'video_source', 'audio_source', 'video_sink', 'audio_sink'],
    controllable: true,
    defaultPorts: [
      out('content_out', 'Content out', 'av'),
      inp('content_in', 'Content in', 'av'),
      inp('audio_in', 'Audio in', 'audio'),
      out('audio_out', 'Audio out', 'audio'),
    ],
  },
  video_matrix: {
    label: 'Video matrix (physical / virtual)',
    section: 'matrix',
    capabilities: ['video_route', 'audio_route', 'signal_detect'],
    controllable: true,
    defaultPorts: [],
  },
  audio_matrix: {
    label: 'Audio matrix / DSP',
    section: 'matrix',
    capabilities: ['audio_route', 'volume', 'mute', 'preset'],
    controllable: true,
    defaultPorts: [],
  },
  video_destination: {
    label: 'Display / projector',
    section: 'destination',
    capabilities: ['video_sink', 'audio_sink', 'power', 'signal_detect'],
    controllable: true,
    defaultPorts: [inp('in', 'Input', 'av')],
  },
  audio_destination: {
    label: 'Speakers / amplifier',
    section: 'destination',
    capabilities: ['audio_sink'],
    controllable: false,
    defaultPorts: [inp('in', 'Input', 'audio')],
  },
  conference_output: {
    label: 'Conference output',
    section: 'destination',
    capabilities: ['video_sink', 'audio_sink'],
    controllable: false,
    defaultPorts: [inp('in', 'Input', 'av')],
  },
  recorder: {
    label: 'Recorder / streamer',
    section: 'destination',
    capabilities: ['record', 'video_sink', 'audio_sink'],
    controllable: true,
    defaultPorts: [inp('in', 'Input', 'av')],
  },
  lighting: {
    label: 'Lighting',
    section: 'environment',
    capabilities: ['lighting', 'preset'],
    controllable: true,
    defaultPorts: [],
  },
  hvac: {
    label: 'HVAC',
    section: 'environment',
    capabilities: ['hvac'],
    controllable: true,
    defaultPorts: [],
  },
  blinds: {
    label: 'Blinds / curtains',
    section: 'environment',
    capabilities: ['blinds'],
    controllable: true,
    defaultPorts: [],
  },
  lifter: {
    label: 'Lifter',
    section: 'environment',
    capabilities: ['mechanical'],
    controllable: true,
    defaultPorts: [],
  },
  screen: {
    label: 'Projection screen',
    section: 'environment',
    capabilities: ['mechanical'],
    controllable: true,
    defaultPorts: [],
  },
};

export function categoryCapabilities(category: DeviceCategory): Capability[] {
  return DEVICE_CATALOG[category].capabilities;
}
