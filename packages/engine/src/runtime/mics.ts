import type { Activity, Device, DeviceCommand, RoomModel } from '@kestrel/model';

/**
 * What the room's reinforcement microphones should do at a moment. By default they are muted when
 * the room is off and unmuted when it turns on; each can be set to leave alone, and an activity can
 * override them for its own run (for example, stay muted during a video call).
 */
export interface MicStep {
  deviceId: string;
  command: DeviceCommand;
}

const driven = (d: Device) => d.category === 'reinforcement_mic' && !!d.control;

/**
 * Steps for a room turning on or an activity starting. `roomWasOff` is true only for a real
 * change from off to on: the default then applies. Other starts change only what the activity
 * overrides.
 */
export function micStartSteps(model: RoomModel, activity: Activity | undefined, roomWasOff: boolean): MicStep[] {
  const steps: MicStep[] = [];
  for (const d of model.devices) {
    if (!driven(d)) continue;
    const choice = activity?.micOverrides?.[d.id] ?? (roomWasOff ? (d.mic?.onStart ?? 'unmute') : 'leave');
    if (choice !== 'leave') steps.push({ deviceId: d.id, command: { type: 'mute', muted: choice === 'mute' } });
  }
  return steps;
}

/** Steps for Room Off. */
export function micStopSteps(model: RoomModel): MicStep[] {
  return model.devices
    .filter((d) => driven(d) && (d.mic?.onStop ?? 'mute') === 'mute')
    .map((d) => ({ deviceId: d.id, command: { type: 'mute', muted: true } }));
}
