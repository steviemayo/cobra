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

  const conferencing = supporting((c) => c === 'conference_system', 'mics.privacy_mute');
  const hasMics = model.devices.some((d) => d.category === 'voice_capture_mic');
  if (hasMics && conferencing.length > 0)
    offered.push({ id: 'mics.privacy_mute', devices: conferencing });
  return offered;
}

export function quickActionCommand(id: QuickActionId, on: boolean): DeviceCommand {
  return id === 'display.blank' ? { type: 'blank', on } : { type: 'mute', muted: on };
}

/** On only when every device it acts on says so; a device that reports nothing counts as off. */
export function quickActionActive(
  action: RoomQuickAction,
  stateOf: (deviceId: string) => DeviceState | undefined,
): boolean {
  return action.devices.every((id) => {
    const s = stateOf(id);
    return action.id === 'display.blank' ? s?.blanked === true : s?.muted === true;
  });
}
