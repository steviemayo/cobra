import {
  isVideoDestination,
  type DeviceBus,
  type DeviceCategory,
  type DeviceCommand,
  type DeviceState,
  type QuickActionId,
  type RoomModel,
} from '@kestrel/model';

/** A quick action this room offers, and the devices it acts on. */
export interface RoomQuickAction {
  id: QuickActionId;
  devices: string[];
  /** Control points of a DSP that do the same (a conferencing microphone privacy mute), by device and point id. */
  points?: { deviceId: string; pointId: string }[];
}

/**
 * Which quick actions a room offers. A driver says what its device can do (through the bus); the room
 * decides whether that makes sense here: Blank Screen needs a display whose driver supports it, and
 * Privacy Mute needs conferencing microphones as well as a conference system that can mute them.
 * The same action on several devices is one button acting on all of them.
 */
export function roomQuickActions(model: RoomModel, bus: DeviceBus): RoomQuickAction[] {
  const supporting = (match: (category: DeviceCategory) => boolean, id: QuickActionId) =>
    model.devices
      .filter((d) => match(d.category) && bus.quickActions?.(d.id).includes(id))
      .map((d) => d.id);

  const offered: RoomQuickAction[] = [];
  const displays = supporting(isVideoDestination, 'display.blank');
  if (displays.length > 0) offered.push({ id: 'display.blank', devices: displays });

  // Privacy Mute acts on every conferencing microphone that can mute itself, and on the conference
  // system where its driver can mute the microphones. It is offered when a microphone can do it, or
  // when the room has conferencing microphones and a conference system that can.
  const conferencing = supporting((c) => c === 'conference_system', 'mics.privacy_mute');
  const mics = model.devices.filter((d) => d.category === 'voice_capture_mic');
  const muting = mics.filter((d) => bus.features?.(d.id)?.includes('privacy_mute')).map((d) => d.id);
  const points = model.devices.flatMap((dsp) =>
    (dsp.points ?? [])
      .filter((p) => p.role === 'mic_privacy_mute' && p.targetId && mics.some((m) => m.id === p.targetId))
      .map((p) => ({ deviceId: dsp.id, pointId: p.id })),
  );
  if (muting.length > 0 || points.length > 0 || (mics.length > 0 && conferencing.length > 0))
    offered.push({
      id: 'mics.privacy_mute',
      devices: [...muting, ...conferencing],
      ...(points.length > 0 ? { points } : {}),
    });
  return offered;
}

export function quickActionCommand(id: QuickActionId, on: boolean): DeviceCommand {
  return id === 'display.blank' ? { type: 'blank', on } : { type: 'mute', muted: on };
}

/** On only when every device and point it acts on says so; one that reports nothing counts as off. */
export function quickActionActive(
  action: RoomQuickAction,
  stateOf: (deviceId: string) => DeviceState | undefined,
): boolean {
  const devices = action.devices.every((id) => {
    const s = stateOf(id);
    return action.id === 'display.blank' ? s?.blanked === true : s?.muted === true;
  });
  return devices && (action.points ?? []).every((p) => stateOf(p.deviceId)?.points[p.pointId] === true);
}
