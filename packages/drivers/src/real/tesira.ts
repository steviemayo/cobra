import { connect, type Socket } from 'node:net';
import {
  pointFromLevel,
  pointToLevel,
  type ControlPoint,
  type Device,
  type DeviceCommand,
  type PointReading,
} from '@kestrel/model';
import { BaseDriver } from './base';
import type { DriverContext } from './types';

// Biamp Tesira over the Tesira Text Protocol (TTP), on the Telnet port (23). Checked against
// Biamp's TTP 4.2 reference. Telnet starts with option negotiation, which a plain client refuses
// (DO is answered WON'T, WILL is answered DON'T); then the server sends a welcome line. Each command
// is `<instance tag> <verb> <attribute> [index] [value]`, and is answered by a line that starts with
// +OK (a successful get carries `"value":...`) or -ERR. The server also echoes what it is sent, so
// only lines that begin +OK or -ERR count as answers. One command is in flight at a time.
//
// The firmware version is read with `DEVICE get version`, every few hours.
//
// Settings: host, port (23), timeoutMs (3000), pollMs (5000).
// Control points: level and mute (`tag` and `index`, the channel), crosspoint (`tag`, `input`,
// `output`). Level points are in dB; the room sees 0 to 100 over the min and max of the point.
// Presets are recalled by name (`DEVICE recallPresetByName`).
const IAC = 0xff;
const DO = 0xfd;
const DONT = 0xfe;
const WILL = 0xfb;
const WONT = 0xfc;
const MAX_BACKOFF_MS = 15_000;
/** How long a firmware reading is trusted before the device is asked again. */
const FIRMWARE_REREAD_MS = 6 * 3_600_000;

interface Waiting {
  resolve: (line: string) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The device answered, but with an error (a point that is not there). It is still reachable. */
class DeviceAnswered extends Error {}

/** A tag with a space in it needs quotes. */
const quote = (tag: string) => (/[\s"]/.test(tag) ? `"${tag.replace(/"/g, '')}"` : tag);
const clean = (v: unknown) => String(v ?? '').replace(/[\r\n\0]/g, '');

export class TesiraDriver extends BaseDriver {
  private socket: Socket | null = null;
  private buffer = '';
  private ready = false;
  private waiting: Waiting | null = null;
  private queue: (() => void)[] = [];
  private busy = false;
  private poller: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private closed = false;
  /** Goes up on every write, so a read that began before one is not allowed to overwrite it. */
  private writes = 0;
  private firmwareAt = 0;

  constructor(device: Device, ctx: DriverContext) {
    super(device, ctx);
    this.state.online = false;
  }

  private get points(): ControlPoint[] {
    return this.device.points ?? [];
  }

  // ---- Connection -----------------------------------------------------------------------------

  override start() {
    if (!this.setting<string>('host', '')) return;
    this.closed = false;
    this.open();
    const every = Math.min(this.setting<number>('pollMs', 5000), 30_000);
    this.poller = setInterval(() => void this.refresh(), every);
    this.poller.unref?.();
  }

  override close() {
    this.closed = true;
    if (this.poller) clearInterval(this.poller);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.poller = this.retryTimer = null;
    this.drop(new Error('closed'));
  }

  private open() {
    if (this.closed || this.socket) return;
    const socket = connect({
      host: this.setting<string>('host', ''),
      port: this.setting<number>('port', 23),
    });
    this.socket = socket;
    socket.setKeepAlive(true, 15_000);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (this.socket === socket) this.drop(new Error(`${this.device.name} disconnected`));
      this.scheduleRetry();
    });
  }

  private drop(reason: Error) {
    const socket = this.socket;
    this.socket = null;
    this.buffer = '';
    this.ready = false;
    socket?.destroy();
    if (this.waiting) {
      clearTimeout(this.waiting.timer);
      this.waiting.reject(reason);
      this.waiting = null;
    }
    this.queue.splice(0).forEach((next) => next());
    this.busy = false;
    this.update((s) => {
      s.online = false;
    });
  }

  private scheduleRetry() {
    if (this.closed || this.retryTimer) return;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.retries++, 4));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
    this.retryTimer.unref?.();
  }

  /** Answers option negotiation (refusing everything) and turns the rest into lines. */
  private onData(chunk: Buffer) {
    const text: number[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i]!;
      if (b !== IAC) {
        text.push(b);
        continue;
      }
      const verb = chunk[i + 1];
      const option = chunk[i + 2];
      if (verb === DO || verb === WILL) {
        this.socket?.write(Buffer.from([IAC, verb === DO ? WONT : DONT, option ?? 0]));
        i += 2;
      } else if (verb === DONT || verb === WONT) i += 2;
      else i += 1; // IAC IAC or another two-byte command: skip it
    }
    this.buffer += Buffer.from(text).toString('latin1');
    let end: number;
    while ((end = this.buffer.search(/\r\n|\r\0|\n|\r/)) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end).replace(/^(\r\n|\r\0|\n|\r)/, '');
      this.onLine(line.trim());
    }
  }

  private onLine(line: string) {
    if (!line) return;
    if (/welcome to the tesira text protocol/i.test(line)) {
      this.ready = true;
      this.retries = 0;
      this.update((s) => {
        s.online = true;
      });
      void this.refresh();
      return;
    }
    if (!/^(\+OK|-ERR)/.test(line) || !this.waiting) return;
    const w = this.waiting;
    this.waiting = null;
    clearTimeout(w.timer);
    if (line.startsWith('-ERR'))
      w.reject(new DeviceAnswered(`${this.device.name}: ${line.slice(5).trim() || 'error'}`));
    else w.resolve(line);
  }

  /** Sends one command and waits for its answer. Commands run one at a time. */
  private command(text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const run = () => {
        const socket = this.socket;
        if (!socket || socket.destroyed || !this.ready) {
          this.busy = false;
          this.queue.shift()?.();
          return reject(new Error(`${this.device.name} is not connected`));
        }
        const timer = setTimeout(
          () => {
            this.waiting = null;
            reject(new Error(`${this.device.name} did not respond`));
            this.next();
          },
          this.setting<number>('timeoutMs', 3000),
        );
        this.waiting = {
          resolve: (l) => {
            resolve(l);
            this.next();
          },
          reject: (e) => {
            reject(e);
            this.next();
          },
          timer,
        };
        socket.write(`${clean(text)}\r\n`);
      };
      if (this.busy) this.queue.push(run);
      else {
        this.busy = true;
        run();
      }
    });
  }

  private next() {
    const next = this.queue.shift();
    if (next) next();
    else this.busy = false;
  }

  // ---- Points ---------------------------------------------------------------------------------

  private tag(p: Pick<ControlPoint, 'address'>) {
    const tag = clean(p.address.tag);
    if (!tag) this.fail('the control point has no instance tag');
    return quote(tag);
  }
  private index(p: Pick<ControlPoint, 'address'>) {
    const n = Number(p.address.index);
    if (!Number.isInteger(n) || n < 0) this.fail('the control point needs a channel number');
    return n;
  }

  private static value(line: string): number | boolean | string {
    const m = /"value":("?)([^"\s]+)\1/.exec(line);
    if (!m) throw new Error('no value in the reply');
    const raw = m[2]!;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }

  private read(p: Pick<ControlPoint, 'type' | 'address'>): Promise<string> {
    if (p.type === 'level') return this.command(`${this.tag(p)} get level ${this.index(p)}`);
    if (p.type === 'mute') return this.command(`${this.tag(p)} get mute ${this.index(p)}`);
    if (p.type === 'crosspoint')
      return this.command(
        `${this.tag(p)} get crosspoint ${Number(p.address.input)} ${Number(p.address.output)}`,
      );
    this.fail(`cannot read a ${p.type} point`);
  }

  private async readFirmware() {
    if (Date.now() - this.firmwareAt < FIRMWARE_REREAD_MS) return;
    this.firmwareAt = Date.now();
    try {
      const version = String(TesiraDriver.value(await this.command('DEVICE get version'))).trim();
      if (version)
        this.update((s) => {
          s.firmware = version.slice(0, 100);
        });
    } catch {
      // A reply without a version is not a fault: the device is still reachable.
    }
  }

  private async refresh() {
    if (!this.ready) return;
    try {
      await this.readFirmware();
      for (const p of this.points) {
        if (!['level', 'mute', 'crosspoint'].includes(p.type)) continue;
        try {
          const epoch = this.writes;
          const v = TesiraDriver.value(await this.read(p));
          if (this.writes !== epoch) continue; // something was set while this was being read: the read is stale
          this.update((s) => {
            s.points[p.id] = p.type === 'level' && typeof v === 'number' ? pointToLevel(p, v) : v;
            if (p.role === 'room_volume' && typeof v === 'number') s.volume = pointToLevel(p, v);
            if (p.role === 'room_mute') s.muted = v === true;
          });
        } catch (e) {
          // A point the DSP does not know is a problem with that point, not a device that is gone.
          if (!(e instanceof DeviceAnswered)) throw e;
          this.ctx.log('warn', 'A Tesira control point could not be read', {
            device: this.device.name,
            point: p.name,
            error: e.message,
          });
        }
      }
      this.update((s) => {
        s.online = true;
      });
    } catch {
      this.update((s) => {
        s.online = false;
      });
    }
  }

  async readPoint(
    point: Pick<ControlPoint, 'type' | 'address' | 'min' | 'max'>,
  ): Promise<PointReading> {
    const value = TesiraDriver.value(await this.read(point));
    if (point.type !== 'level') return { value };
    const reading: PointReading = { value };
    for (const [attribute, key] of [
      ['minLevel', 'min'],
      ['maxLevel', 'max'],
    ] as const) {
      const line = await this.command(
        `${this.tag(point)} get ${attribute} ${this.index(point)}`,
      ).catch(() => null);
      const v = line ? TesiraDriver.value(line) : null;
      if (typeof v === 'number') reading[key] = v;
    }
    return reading;
  }

  private async setPoint(p: ControlPoint, value: number | boolean | string) {
    this.writes++;
    if (p.type === 'level')
      await this.command(
        `${this.tag(p)} set level ${this.index(p)} ${pointFromLevel(p, Number(value))}`,
      );
    else if (p.type === 'mute')
      await this.command(
        `${this.tag(p)} set mute ${this.index(p)} ${value === true || value === 'true' ? 'true' : 'false'}`,
      );
    else if (p.type === 'crosspoint')
      await this.command(
        `${this.tag(p)} set crosspoint ${Number(p.address.input)} ${Number(p.address.output)} ${value === true || value === 'true' ? 'true' : 'false'}`,
      );
    else this.fail(`cannot set a ${p.type} point`);
    this.update((s) => {
      s.points[p.id] = value;
      if (p.role === 'room_volume') s.volume = Number(value);
      if (p.role === 'room_mute') s.muted = value === true;
    });
  }

  // ---- Commands -------------------------------------------------------------------------------

  async send(command: DeviceCommand): Promise<void> {
    switch (command.type) {
      case 'point': {
        const point = this.points.find((p) => p.id === command.pointId);
        if (!point) this.fail(`has no control point "${command.pointId}"`);
        return this.setPoint(point, command.value);
      }
      case 'volume': {
        const p = this.points.find((x) => x.role === 'room_volume');
        if (!p) this.fail('has no control point with the role "room volume"');
        return this.setPoint(p, command.level);
      }
      case 'mute': {
        const p = this.points.find((x) => x.role === 'room_mute');
        if (!p) this.fail('has no control point with the role "room mute"');
        return this.setPoint(p, command.muted);
      }
      case 'preset': {
        await this.command(`DEVICE recallPresetByName "${clean(command.name).replace(/"/g, '')}"`);
        this.update((s) => {
          s.preset = command.name;
        });
        return;
      }
      case 'power':
      case 'route':
      case 'select_input':
        // Fixed by the Tesira design, not by Kestrel.
        return;
      default:
        this.fail(`does not support "${command.type}"`);
    }
  }
}
