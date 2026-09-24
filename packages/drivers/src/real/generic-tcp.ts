import { connect, type Socket } from 'node:net';
import type { Device, DeviceCommand } from '@kestrel/model';
import { BaseDriver } from './base';
import type { DriverContext } from './types';

// Generic ASCII-over-TCP control. Everything device-specific lives in the device's settings:
//   host, port, terminator (default "\r\n"), timeoutMs, expect (regex a reply must match),
//   commands: { "power.on": "PWR ON", "volume": "VOL {level}", "route": "SW I{input} O{output}", ... }
// Placeholders: {level} {input} {output} {name}. Custom commands use "command.<name>".
export class GenericTcpDriver extends BaseDriver {
  constructor(device: Device, ctx: DriverContext) {
    super(device, ctx);
    this.state.online = false;
  }

  private probeSocket: Socket | null = null;

  /**
   * This protocol has no feedback, so the device would look offline until the first command.
   * Connect once at start so a release can tell a reachable device from a wrong address.
   */
  override start() {
    const host = this.setting<string>('host', '');
    if (!host) return;
    const socket = connect({ host, port: this.setting<number>('port', 23) });
    this.probeSocket = socket;
    const settle = (online: boolean) => {
      socket.destroy();
      if (this.probeSocket === socket) this.probeSocket = null;
      this.update((s) => {
        s.online = online;
      });
    };
    socket.setTimeout(this.setting<number>('timeoutMs', 2000), () => settle(false));
    socket.on('connect', () => settle(true));
    socket.on('error', () => settle(false));
  }

  override close() {
    this.probeSocket?.destroy();
  }

  private template(command: DeviceCommand): string {
    const commands = this.setting<Record<string, string>>('commands', {});
    const key =
      command.type === 'power'
        ? `power.${command.on ? 'on' : 'off'}`
        : command.type === 'mute'
          ? `mute.${command.muted ? 'on' : 'off'}`
          : command.type === 'record'
            ? `record.${command.on ? 'on' : 'off'}`
            : command.type === 'command'
              ? `command.${command.name}`
              : command.type;
    const t = commands[key];
    if (t === undefined) this.fail(`no "${key}" command configured`);
    const vars: Record<string, string> = {};
    if (command.type === 'volume') vars.level = String(command.level);
    if (command.type === 'route') {
      vars.input = command.inputPortId.replace(/\D+/g, '') || command.inputPortId;
      vars.output = command.outputPortId.replace(/\D+/g, '') || command.outputPortId;
    }
    if (command.type === 'select_input') vars.input = command.portId.replace(/\D+/g, '') || command.portId;
    if (command.type === 'preset' || command.type === 'camera_preset' || command.type === 'scene')
      vars.name = command.name;
    return t.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
  }

  private transmit(text: string): Promise<void> {
    const host = this.setting<string>('host', '');
    if (!host) return Promise.reject(new Error(`${this.device.name}: no host configured`));
    const port = this.setting<number>('port', 23);
    const terminator = this.setting<string>('terminator', '\r\n');
    const timeoutMs = this.setting<number>('timeoutMs', 2000);
    const expectSource = this.setting<string | undefined>('expect', undefined);
    const expect = expectSource ? new RegExp(expectSource) : null;
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      let reply = '';
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error(`${this.device.name} did not respond`)),
        timeoutMs,
      );
      socket.on('error', (e) => finish(new Error(`${this.device.name}: ${e.message}`)));
      socket.on('connect', () => {
        socket.write(text + terminator, (err) => {
          if (err) finish(err);
          else if (!expect) finish();
        });
      });
      socket.on('data', (chunk) => {
        reply += chunk.toString('latin1');
        if (expect?.test(reply)) finish();
      });
      socket.on('close', () => {
        if (expect && !expect.test(reply)) finish(new Error(`${this.device.name} sent an unexpected reply`));
      });
    });
  }

  async send(command: DeviceCommand): Promise<void> {
    const text = this.template(command);
    try {
      await this.transmit(text);
    } catch (e) {
      this.update((s) => {
        s.online = false;
      });
      throw e;
    }
    // No feedback channel in this protocol: assume the device did what it was told.
    this.update((s) => {
      s.online = true;
      switch (command.type) {
        case 'power':
          s.power = command.on ? 'on' : 'off';
          break;
        case 'mute':
          s.muted = command.muted;
          break;
        case 'volume':
          s.volume = command.level;
          break;
        case 'route':
          s.routes[command.outputPortId] = command.inputPortId;
          break;
        case 'select_input':
          s.selectedInput = command.portId;
          break;
        case 'preset':
        case 'camera_preset':
        case 'scene':
          s.preset = command.name;
          break;
        case 'record':
          s.recording = command.on;
          break;
      }
    });
  }
}
