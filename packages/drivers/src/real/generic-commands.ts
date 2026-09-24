import { escapeLine, type DeviceCommand } from '@kestrel/model';

/** The name a generic driver's `commands` map uses for a room command, e.g. "power.on" or "command.reboot". */
export function commandKey(command: DeviceCommand): string {
  return command.type === 'power'
    ? `power.${command.on ? 'on' : 'off'}`
    : command.type === 'mute'
      ? `mute.${command.muted ? 'on' : 'off'}`
      : command.type === 'record'
        ? `record.${command.on ? 'on' : 'off'}`
        : command.type === 'command'
          ? `command.${command.name}`
          : command.type;
}

/** Values a command template may use: {level} {input} {output} {name}. Port ids like "in2" give 2. */
export function commandVars(command: DeviceCommand): Record<string, string> {
  const digits = (id: string) => id.replace(/\D+/g, '') || id;
  const vars: Record<string, string> = {};
  if (command.type === 'volume') vars.level = String(command.level);
  if (command.type === 'route') {
    vars.input = digits(command.inputPortId);
    vars.output = digits(command.outputPortId);
  }
  if (command.type === 'select_input') vars.input = digits(command.portId);
  if (command.type === 'preset' || command.type === 'camera_preset' || command.type === 'scene')
    vars.name = command.name;
  return vars;
}

/**
 * Fills a command template from the device's `commands` setting. Returns null if the device has no
 * template for this command. Values lose their control characters, so a name can never smuggle a
 * second command into what is sent.
 */
export function renderGenericCommand(
  commands: Record<string, string>,
  command: DeviceCommand,
): { key: string; text: string } | { key: string; text: null } {
  const key = commandKey(command);
  const template = commands[key];
  if (template === undefined) return { key, text: null };
  const vars = commandVars(command);
  return { key, text: template.replace(/\{(\w+)\}/g, (_, k: string) => escapeLine(vars[k] ?? '')) };
}
