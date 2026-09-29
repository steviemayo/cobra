import type { Device, DeviceCommand, DeviceDetailSection } from '@kestrel/model';
import { askConsole, consoleAddressBlocked, tellConsole, type ConsoleTarget } from './ascii-console';
import { BaseDriver } from './base';
import type { DriverContext } from './types';

// Blustream ACM1000: a virtual AVoIP matrix over its ASCII console (checked against Blustream's own
// command reference). The commissioner's own scan/assign step wires up the encoders and decoders on
// the ACM1000 itself, so Kestrel only ever talks to the ACM1000, never to the endpoints: `route`
// sends `OUT <output> FR <input>`, the same shape as any physical matrix (category `video_matrix`,
// class `avoip_switching`, docs/driver-classes.md's "controller-based systems: some vendors route by
// name through a controller. Same class, the driver just calls the controller instead of each
// decoder"). Port ids are read by trailing digit ("out3" is output 3), the same convention the
// declarative format uses, and are sent zero-padded to 3 digits as the reference's own examples
// show ("ooo=[001...n]").
//
// Settings: host, port (23), pollMs (20000, how often the port list is refreshed), timeoutMs (4000).
//
// NOT YET VERIFIED AGAINST REAL HARDWARE: the reference documents `STATUS`, `IN STATUS` and
// `OUT STATUS` as printing "detailed status" but never shows an example, so the number of inputs and
// outputs is read by counting distinct `IN`/`OUT` port numbers mentioned in the reply rather than a
// named field, and the raw reply is always kept as its own details row too, so a guess that misses
// still leaves the real answer visible. Control commands (`OUT ... FR ...`) are one-way: the
// reference shows no acknowledgement text for them either, so a route counts as done once it is sent.

const pad3 = (n: number) => String(Math.max(1, n)).padStart(3, '0');
const portNumber = (id: string) => Number(/\d+/.exec(id)?.[0] ?? '1');

/** Distinct port numbers mentioned as "IN <n>" / "OUT <n>" anywhere in a status reply. */
function countPorts(text: string, tag: 'IN' | 'OUT'): number[] {
  const re = new RegExp(`\\b${tag}\\s*0*(\\d+)\\b`, 'gi');
  const found = new Set<number>();
  for (const m of text.matchAll(re)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

export class BlustreamAcm1000Driver extends BaseDriver {
  private poller: ReturnType<typeof setInterval> | null = null;

  constructor(device: Device, ctx: DriverContext) {
    super(device, ctx);
    this.state.online = false;
  }

  override start() {
    const host = this.setting<string>('host', '');
    if (!host) return;
    if (consoleAddressBlocked(host, this.device.settings)) {
      this.ctx.log(
        'error',
        `${this.device.name}'s address (${host}) is a cloud metadata address, not a device, and was refused`,
        { device: this.device.name, hint: 'Add "allowLocalAddress": true to this device’s settings if this is deliberate' },
      );
      return;
    }
    void this.poll();
    const every = this.setting<number>('pollMs', 20000);
    this.poller = setInterval(() => void this.poll(), every);
    this.poller.unref?.();
  }

  override close() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  private connectTarget(): ConsoleTarget | Error {
    const host = this.setting<string>('host', '');
    if (!host) return new Error(`${this.device.name}: no host configured`);
    if (consoleAddressBlocked(host, this.device.settings))
      return new Error(`${host} is a cloud metadata address, not a device (add "allowLocalAddress": true to allow it)`);
    return { host, port: this.setting<number>('port', 23) };
  }

  private ask(text: string): Promise<string> {
    const target = this.connectTarget();
    if (target instanceof Error) return Promise.reject(target);
    return askConsole(target, text, this.setting<number>('timeoutMs', 4000), this.device.name);
  }

  private tell(text: string): Promise<void> {
    const target = this.connectTarget();
    if (target instanceof Error) return Promise.reject(target);
    return tellConsole(target, text, this.setting<number>('timeoutMs', 4000), this.device.name);
  }

  private async poll() {
    try {
      const reply = await this.ask('STATUS');
      this.applyStatus(reply);
      this.update((s) => {
        s.online = true;
      });
    } catch {
      this.update((s) => {
        s.online = false;
      });
    }
  }

  private applyStatus(raw: string) {
    const text = raw.replace(/[^\x20-\x7e\r\n]/g, '').trim();
    const inputs = countPorts(text, 'IN');
    const outputs = countPorts(text, 'OUT');
    const rows: DeviceDetailSection['rows'] = [];
    if (inputs.length) rows.push({ label: 'Inputs seen', value: `${inputs.length} (${inputs.join(', ')})` });
    if (outputs.length) rows.push({ label: 'Outputs seen', value: `${outputs.length} (${outputs.join(', ')})` });
    if (text) rows.push({ label: 'Status (raw reply)', value: text.slice(0, 200) });
    if (rows.length)
      this.update((s) => {
        s.details = [{ title: 'ACM1000', rows }];
      });
  }

  async send(command: DeviceCommand): Promise<void> {
    if (command.type !== 'route') this.fail(`does not support "${command.type}"`);
    const text = `OUT ${pad3(portNumber(command.outputPortId))} FR ${pad3(portNumber(command.inputPortId))}`;
    try {
      await this.tell(text);
    } catch (e) {
      this.update((s) => {
        s.online = false;
      });
      throw e;
    }
    this.update((s) => {
      s.online = true;
      s.routes[command.outputPortId] = command.inputPortId;
    });
  }
}
