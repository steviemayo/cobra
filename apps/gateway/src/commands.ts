import { hostname } from 'node:os';
import type { CommandResult, GatewayCommand } from '@kestrel/model';
import type { RoomHost } from './room-host';

export interface GatewayFacts {
  version: string;
  uptimeSeconds: number;
  bufferedEvents: number;
}

const fail = (error: string, output: Record<string, unknown> = {}): CommandResult => ({
  id: '',
  ok: false,
  output,
  error,
});

/**
 * Runs one allowlisted command. Anything the cloud sends that is not in the allowlist is refused
 * here as well: the gateway never trusts the far end to have checked.
 */
export function runCommand(
  host: RoomHost,
  cmd: GatewayCommand,
  facts: GatewayFacts,
): CommandResult {
  return { ...execute(host, cmd, facts), id: cmd.id };
}

function execute(host: RoomHost, cmd: GatewayCommand, facts: GatewayFacts): CommandResult {
  const room = host.get(cmd.roomId);
  if (!room) return fail('That room is not running on this gateway');
  const model = room.signed.manifest.model;

  switch (cmd.type) {
    case 'diagnostics': {
      const devices = model.devices.map((d) => {
        const s = room.bus.getState(d.id);
        return {
          id: d.id,
          name: d.name,
          online: s?.online ?? true,
          power: s?.power ?? null,
          selectedInput: s?.selectedInput ?? null,
          muted: s?.muted ?? null,
          volume: s?.volume ?? null,
        };
      });
      const offline = devices.filter((d) => !d.online).map((d) => d.name);
      return {
        id: '',
        ok: offline.length === 0,
        error: offline.length ? `Not answering: ${offline.join(', ')}` : undefined,
        output: {
          room: {
            name: room.signed.manifest.roomName,
            release: room.signed.manifest.releaseNumber,
            status: room.runtime.getSnapshot().status,
          },
          devices,
          gateway: { ...facts, hostname: hostname(), node: process.version },
        },
      };
    }
    case 'test_device': {
      const device = model.devices.find((d) => d.id === cmd.args.deviceId);
      if (!device) return fail('That device is not in this room');
      const state = room.bus.getState(device.id);
      const online = state?.online ?? true;
      return {
        id: '',
        ok: online,
        error: online ? undefined : `${device.name} is not answering`,
        output: { device: device.name, online, state: state ?? null },
      };
    }
    case 'restart_room': {
      host.load(room.signed, room.bindings);
      return { id: '', ok: true, output: { restarted: room.signed.manifest.roomName } };
    }
    case 'room_off': {
      // While walls are open the combined room is the one in charge of this room's devices.
      const running = host.active(cmd.roomId) ?? room;
      const off = running.runtime.getSnapshot().activities.find((a) => a.kind === 'room_off');
      if (!off) return fail('This room has no Room Off activity');
      running.runtime.dispatch({ type: 'activity.start', activityId: off.id });
      return { id: '', ok: true, output: {} };
    }
    default:
      return fail('That command is not supported by this gateway');
  }
}
