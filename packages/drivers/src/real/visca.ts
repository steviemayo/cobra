import { createSocket, type Socket } from 'node:dgram';
import type { Device, DeviceCommand } from '@kestrel/model';
import { BaseDriver } from './base';
import type { DriverContext } from './types';

// PTZ cameras that speak VISCA over IP (Sony, PTZOptics, Lumens, most broadcast-style PTZ heads),
// used for camera presets and power. Settings:
//   host, port (52381), presets: { "Wide": 0, "Podium": 1 }  (name -> the camera's preset number,
//   0-127; a name that is just a number is used as it is), cameraAddress (1), pollMs (10000),
//   timeoutMs (1500)
// VISCA over IP wraps each command in an 8 byte header (type, length, sequence number) and sends
// it as a UDP datagram; the camera answers with an ACK and then a completion.

const TYPE_COMMAND = 0x0100;
const TYPE_INQUIRY = 0x0110;
const TYPE_RESET = 0x0200;

function packet(type: number, seq: number, payload: number[]): Buffer {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt16BE(type, 0);
  b.writeUInt16BE(payload.length, 2);
  b.writeUInt32BE(seq >>> 0, 4);
  Buffer.from(payload).copy(b, 8);
  return b;
}

export class ViscaDriver extends BaseDriver {
  private socket: Socket | null = null;
  private seq = 1;
  private poller: ReturnType<typeof setInterval> | null = null;
  private pending = new Map<number, { resolve: (payload: Buffer) => void; done: (p: Buffer) => boolean; timer: ReturnType<typeof setTimeout>; reject: (e: Error) => void }>();
  private busy = false;

  constructor(device: Device, ctx: DriverContext) {
    super(device, ctx);
    this.state.online = false;
  }

  private get address() {
    return this.setting<number>('cameraAddress', 1);
  }

  override start() {
    const host = this.setting<string>('host', '');
    if (!host) return;
    const socket = createSocket('udp4');
    this.socket = socket;
    socket.on('message', (msg) => this.onMessage(msg));
    socket.on('error', () => undefined);
    // A fresh session: the camera forgets sequence numbers and drops anything left over.
    socket.send(packet(TYPE_RESET, 0, [0x01]), this.setting<number>('port', 52381), host, () => undefined);
    void this.refresh();
    this.poller = setInterval(() => void this.refresh(), this.setting<number>('pollMs', 10_000));
    this.poller.unref?.();
  }

  override close() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('closed'));
    }
    this.pending.clear();
    this.socket?.close();
    this.socket = null;
  }

  private onMessage(msg: Buffer) {
    if (msg.length < 9) return;
    const seq = msg.readUInt32BE(4);
    const payload = msg.subarray(8);
    const p = this.pending.get(seq);
    if (!p) return;
    if (p.done(payload)) {
      clearTimeout(p.timer);
      this.pending.delete(seq);
      p.resolve(payload);
    }
  }

  /** Sends one VISCA message and waits for the reply that finishes it (a completion, or an inquiry answer). */
  private exchange(type: number, payload: number[], finished: (p: Buffer) => boolean): Promise<Buffer> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error(`${this.device.name} is not running`));
    const seq = this.seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`${this.device.name} did not respond`));
      }, this.setting<number>('timeoutMs', 1500));
      this.pending.set(seq, {
        resolve,
        reject,
        timer,
        done: (p) => {
          // 0x6y is an error reply, which also ends the exchange.
          const kind = p[1]! & 0xf0;
          if (kind === 0x60) {
            clearTimeout(timer);
            this.pending.delete(seq);
            reject(new Error(`${this.device.name} refused the command (error ${(p[2] ?? 0).toString(16)})`));
            return false;
          }
          return finished(p);
        },
      });
      socket.send(packet(type, seq, payload), this.setting<number>('port', 52381), this.setting<string>('host', ''), (e) => {
        if (e) {
          clearTimeout(timer);
          this.pending.delete(seq);
          reject(e);
        }
      });
    });
  }

  /** Power inquiry: proves the camera is there, and tells us whether it is on. */
  private async refresh() {
    if (this.busy || !this.socket) return;
    this.busy = true;
    try {
      const reply = await this.exchange(TYPE_INQUIRY, [0x80 | this.address, 0x09, 0x04, 0x00, 0xff], (p) => (p[1]! & 0xf0) === 0x50);
      const power = reply[2] === 0x02 ? 'on' : reply[2] === 0x03 ? 'off' : undefined;
      this.update((s) => {
        s.online = true;
        if (power) s.power = power;
      });
    } catch {
      this.update((s) => {
        s.online = false;
      });
    } finally {
      this.busy = false;
    }
  }

  private presetNumber(name: string): number {
    const map = this.setting<Record<string, number>>('presets', {});
    const n = map[name] ?? (/^\d+$/.test(name) ? Number(name) : NaN);
    if (!Number.isInteger(n) || n < 0 || n > 127) this.fail(`unknown camera preset "${name}"`);
    return n;
  }

  async send(command: DeviceCommand): Promise<void> {
    const a = 0x80 | this.address;
    const completion = (p: Buffer) => (p[1]! & 0xf0) === 0x50;
    switch (command.type) {
      case 'camera_preset': {
        await this.exchange(TYPE_COMMAND, [a, 0x01, 0x04, 0x3f, 0x02, this.presetNumber(command.name), 0xff], completion);
        this.update((s) => {
          s.online = true;
          s.preset = command.name;
        });
        return;
      }
      case 'power': {
        await this.exchange(TYPE_COMMAND, [a, 0x01, 0x04, 0x00, command.on ? 0x02 : 0x03, 0xff], completion);
        this.update((s) => {
          s.online = true;
          s.power = command.on ? 'on' : 'off';
        });
        return;
      }
      default:
        this.fail(`does not support "${command.type}"`);
    }
  }
}
