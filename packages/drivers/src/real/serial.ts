import { hasCatastrophicBacktracking, type Device, type DeviceCommand } from '@kestrel/model';
import { BaseDriver } from './base';
import { renderGenericCommand } from './generic-commands';
import { Reconnect } from './reconnect';
import type { DriverContext } from './types';

// Generic ASCII-over-serial control (RS-232 / RS-485 through a USB adaptor on the gateway machine).
// Everything device specific lives in the device's settings:
//   path (COM3 or /dev/ttyUSB0), baudRate (9600), dataBits (8), stopBits (1), parity ("none"),
//   terminator (default "\r"), timeoutMs (2000), expect (regex a reply must match),
//   commands: { "power.on": "PWR ON", "volume": "VOL {level}", ... }  (same names as generic TCP)
// A Docker gateway needs the port passed through: docker run --device /dev/ttyUSB0 ...

export interface SerialLike {
  write(data: string, cb?: (err?: Error | null) => void): unknown;
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  on(event: 'close' | 'error', cb: (err?: Error) => void): unknown;
  close(cb?: (err?: Error | null) => void): unknown;
  isOpen: boolean;
}
export type SerialOpener = (opts: {
  path: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 1.5 | 2;
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
}) => Promise<SerialLike>;

/** Opens a real port. serialport is only loaded when a device actually uses serial. */
const openReal: SerialOpener = async (opts) => {
  const { SerialPort } = await import('serialport');
  return new Promise<SerialLike>((resolve, reject) => {
    const port = new SerialPort({ ...opts, autoOpen: false });
    port.open((err) => (err ? reject(err) : resolve(port as unknown as SerialLike)));
  });
};

export class SerialDriver extends BaseDriver {
  private port: SerialLike | null = null;
  private buffer = '';
  private waiting: { re: RegExp | null; resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private readonly reconnect = new Reconnect(() => void this.open());

  constructor(
    device: Device,
    ctx: DriverContext,
    private readonly opener: SerialOpener = openReal,
  ) {
    super(device, ctx);
    this.state.online = false;
  }

  override start() {
    if (!this.setting<string>('path', '')) return;
    this.reconnect.restart();
    void this.open();
  }

  override close() {
    this.reconnect.stop();
    this.drop(new Error('closed'));
  }

  private async open() {
    if (this.reconnect.closed || this.port) return;
    try {
      const port = await this.opener({
        path: this.setting<string>('path', ''),
        baudRate: this.setting<number>('baudRate', 9600),
        dataBits: this.setting<5 | 6 | 7 | 8>('dataBits', 8),
        stopBits: this.setting<1 | 1.5 | 2>('stopBits', 1),
        parity: this.setting<'none' | 'even' | 'odd' | 'mark' | 'space'>('parity', 'none'),
      });
      if (this.reconnect.closed) return void port.close();
      this.port = port;
      this.reconnect.succeeded();
      port.on('data', (chunk: Buffer) => this.onData(chunk.toString('latin1')));
      port.on('error', () => undefined);
      port.on('close', () => {
        if (this.port === port) this.drop(new Error(`${this.device.name} disconnected`));
        this.reconnect.schedule();
      });
      this.update((s) => {
        s.online = true;
      });
    } catch (e) {
      this.ctx.log('warn', 'Could not open the serial port', { device: this.device.name, error: String(e) });
      this.reconnect.schedule();
    }
  }

  private drop(reason: Error) {
    const port = this.port;
    this.port = null;
    this.buffer = '';
    if (port?.isOpen) port.close(() => undefined);
    for (const w of this.waiting.splice(0)) {
      clearTimeout(w.timer);
      w.reject(reason);
    }
    this.update((s) => {
      s.online = false;
    });
  }

  private onData(chunk: string) {
    this.buffer = (this.buffer + chunk).slice(-16_384);
    const term = this.setting<string>('terminator', '\r');
    let i: number;
    while ((i = this.buffer.indexOf(term)) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\n$/, '');
      this.buffer = this.buffer.slice(i + term.length);
      if (!line) continue;
      const w = this.waiting[0];
      if (w && (!w.re || w.re.test(line))) {
        this.waiting.shift();
        clearTimeout(w.timer);
        w.resolve();
      }
    }
  }

  async send(command: DeviceCommand): Promise<void> {
    const rendered = renderGenericCommand(this.setting<Record<string, string>>('commands', {}), command);
    if (rendered.text === null) this.fail(`no "${rendered.key}" command configured`);
    const port = this.port;
    if (!port?.isOpen) this.fail('the serial port is not open');
    const expectSource = this.setting<string | undefined>('expect', undefined);
    if (expectSource && hasCatastrophicBacktracking(expectSource))
      this.ctx.log('error', `"expect" pattern "${expectSource}" could hang the gateway and was not used`, {
        device: this.device.id,
      });
    const wait = new Promise<void>((resolve, reject) => {
      if (!expectSource || hasCatastrophicBacktracking(expectSource)) return resolve();
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w.timer !== timer);
        reject(new Error(`${this.device.name} did not respond`));
      }, this.setting<number>('timeoutMs', 2000));
      this.waiting.push({ re: new RegExp(expectSource), resolve, reject, timer });
    });
    await new Promise<void>((resolve, reject) =>
      port.write(rendered.text + this.setting<string>('terminator', '\r'), (e) => (e ? reject(e) : resolve())),
    );
    await wait;
    this.update((s) => {
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
          s.preset = command.name;
          break;
        case 'record':
          s.recording = command.on;
          break;
      }
    });
  }
}
