import { type CommandResult, type GatewayCommand } from '@kestrel/model';
import type { DeviceHost } from './device-host';
import { discoverDevices } from './discovery';

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
export async function runCommand(
  cmd: GatewayCommand,
  devices?: DeviceHost,
): Promise<CommandResult> {
  return { ...(await execute(cmd, devices)), id: cmd.id };
}

async function execute(cmd: GatewayCommand, devices?: DeviceHost): Promise<CommandResult> {
  switch (cmd.type) {
    case 'discover_devices': {
      // Looks at the gateway's own private networks and reports what answers. Reads only.
      const subnet = cmd.args.subnet;
      if (subnet && !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(subnet))
        return fail('That is not a network address');
      const found = await discoverDevices(subnet ? { subnets: [subnet] } : {});
      if (found.subnets.length === 0)
        return fail(
          subnet
            ? 'The gateway is not on that network'
            : 'The gateway is not on a private network it can look at',
          { ...found },
        );
      return { id: '', ok: true, output: { ...found } };
    }
    case 'browse_points': {
      // Reads one running device's own tree and lists what a control point could watch. Reads only.
      const deviceId = cmd.args.deviceId;
      if (!deviceId || !devices) return fail('That command is not supported by this gateway');
      const browsed = await devices.browse(deviceId);
      return browsed.ok ? { id: '', ok: true, output: { ...browsed.found } } : fail(browsed.error);
    }
    case 'snapshot': {
      // One picture from a camera, sent back and not kept. The portal only asks when the organisation
      // has turned previews on; the gateway just takes the picture it is asked for.
      const deviceId = cmd.args.deviceId;
      if (!deviceId || !devices) return fail('That command is not supported by this gateway');
      const shot = await devices.snapshot(deviceId);
      return shot.ok
        ? { id: '', ok: true, output: { contentType: shot.contentType, data: shot.data } }
        : fail(shot.error);
    }
    default:
      return fail('That command is not supported by this gateway');
  }
}
