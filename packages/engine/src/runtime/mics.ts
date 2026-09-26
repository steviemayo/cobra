import type { Activity, ControlPoint, Device, DeviceBus, DeviceCommand, RoomModel } from '@kestrel/model';

/**
 * What the room's reinforcement microphones should do at a moment. By default they are muted when
 * the room is off and unmuted when it turns on; each can be set to leave alone, and an activity can
 * override them for its own run (for example, stay muted during a video call).
 */
export interface MicStep {
  deviceId: string;
  command: DeviceCommand;
}

/**
 * How a microphone is controlled: by its own driver, or through control points on a DSP that carry
 * the roles "microphone mute" and "microphone level" for it. Its own driver wins when it has one.
 */
export interface MicTarget {
  /** The device that gets the commands: the microphone itself, or the DSP. */
  deviceId: string;
  /** Through the DSP: the points. Absent when the microphone is driven directly. */
  mute?: ControlPoint;
  level?: ControlPoint;
}

export function micTarget(model: RoomModel, mic: Device): MicTarget | null {
  if (mic.control) return { deviceId: mic.id };
  for (const dsp of model.devices) {
    const points = (dsp.points ?? []).filter((p) => p.targetId === mic.id);
    const mute = points.find((p) => p.role === 'mic_mute');
    const level = points.find((p) => p.role === 'mic_level');
    if (mute || level) return { deviceId: dsp.id, ...(mute ? { mute } : {}), ...(level ? { level } : {}) };
  }
  return null;
}

export function muteCommand(target: MicTarget, muted: boolean): DeviceCommand {
  return target.mute ? { type: 'point', pointId: target.mute.id, value: muted } : { type: 'mute', muted };
}

export function levelCommand(target: MicTarget, level: number): DeviceCommand {
  return target.level ? { type: 'point', pointId: target.level.id, value: level } : { type: 'volume', level };
}

/** Whether the volume buttons work for this microphone. */
export function micCanVolume(bus: DeviceBus, mic: Device, target: MicTarget): boolean {
  return target.level ? true : (bus.features?.(mic.id) ?? []).includes('volume');
}

/** What the microphone reports, wherever it lives (its own state, or a point of the DSP). */
export function micReported(bus: DeviceBus, target: MicTarget) {
  const state = bus.getState(target.deviceId);
  const muted = target.mute ? state?.points[target.mute.id] : state?.muted;
  const level = target.level ? state?.points[target.level.id] : state?.volume;
  return {
    muted: typeof muted === 'boolean' ? muted : null,
    volume: typeof level === 'number' ? level : null,
  };
}

const isMic = (d: Device) => d.category === 'reinforcement_mic';

/**
 * Steps for a room turning on or an activity starting. `roomWasOff` is true only for a real
 * change from off to on: the default then applies. Other starts change only what the activity
 * overrides.
 */
export function micStartSteps(model: RoomModel, activity: Activity | undefined, roomWasOff: boolean): MicStep[] {
  const steps: MicStep[] = [];
  for (const d of model.devices) {
    if (!isMic(d)) continue;
    const target = micTarget(model, d);
    if (!target) continue;
    const choice = activity?.micOverrides?.[d.id] ?? (roomWasOff ? (d.mic?.onStart ?? 'unmute') : 'leave');
    if (choice !== 'leave') steps.push({ deviceId: target.deviceId, command: muteCommand(target, choice === 'mute') });
  }
  return steps;
}

/** Steps for Room Off. */
export function micStopSteps(model: RoomModel): MicStep[] {
  const steps: MicStep[] = [];
  for (const d of model.devices) {
    if (!isMic(d) || (d.mic?.onStop ?? 'mute') !== 'mute') continue;
    const target = micTarget(model, d);
    if (target) steps.push({ deviceId: target.deviceId, command: muteCommand(target, true) });
  }
  return steps;
}
