import { type CommandResult, type GatewayCommand } from '@kestrel/model';
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
export async function runCommand(cmd: GatewayCommand): Promise<CommandResult> {
  return { ...(await execute(cmd)), id: cmd.id };
}

async function execute(cmd: GatewayCommand): Promise<CommandResult> {
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
    default:
      return fail('That command is not supported by this gateway');
  }
}
