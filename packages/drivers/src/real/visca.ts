import { createSocket, type Socket } from 'node:dgram';
import { connect, type Socket as NetSocket } from 'node:net';
import type { Device, DeviceCommand } from '@kestrel/model';
import { BaseDriver } from './base';
import type { DriverContext } from './types';

// PTZ cameras that speak VISCA over IP (Sony, PTZOptics, Lumens, Crestron 1 Beyond, most
// broadcast-style PTZ heads), used for camera presets, pointing and power. Settings:
//   host, transport ("udp" default, or "tcp"), framing ("ip" or "raw"), port, presets:
//   { "Wide": 0, "Podium": 1 }  (name -> the camera's preset number, 0-127; a name that is just a
//   number is used as it is), cameraAddress (1), pollMs (10000), timeoutMs (1500),
//   panSpeed (1-24, default 12), tiltSpeed (1-20, default 10), zoomSpeed (0-7, default 3)
// Framing "ip" is VISCA over IP proper: each message has an 8 byte header (type, length, sequence
// number). Framing "raw" is plain serial VISCA carried as it is, each message ending in 0xFF, which
// is what most cameras expect over TCP. The defaults are udp + ip (port 52381) and, when transport is
// tcp, raw (port 5678). The camera answers a command with an ACK and then a completion.

const TYPE_COMMAND = 0x0100;
const TYPE_INQUIRY = 0x0110;
const TYPE_RESET = 0x0200;

type Transport = 'udp' | 'tcp';
type Framing = 'ip' | 'raw';

function packet(type: number, seq: number, payload: number[]): Buffer {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt16BE(type, 0);
  b.writeUInt16BE(payload.length, 2);
  b.writeUInt32BE(seq >>> 0, 4);
  Buffer.from(payload).copy(b, 8);
  return b;
}

interface Pending {
  resolve: (payload: Buffer) => void;
  reject: (e: Error) => void;
  done: (p: Buffer) => boolean;
  timer: ReturnType<typeof setTimeout>;
}

// Raw framing has no sequence numbers, so one exchange at a time uses this key.
const RAW_KEY = 0;
// More than this without a terminator is not VISCA; drop it rather than grow without end.
const MAX_RAW_BYTES = 4096;

export class ViscaDriver extends BaseDriver {
  private socket: Socket | null = null;
  private tcp: NetSocket | null = null;
  private connecting: Promise<NetSocket> | null = null;
  private rx: Buffer = Buffer.alloc(0);
  private running = false;
  private seq = 1;
  private poller: ReturnType<typeof setInterval> | null = null;
  private pending = new Map<number, Pending>();
  private chain: Promise<unknown> = Promise.resolve();
  private busy = false;

  constructor(device: Device, ctx: DriverContext) {
    super(device, ctx);
    this.state.online = false;
  }

  private get address() {
    return this.setting<number>('cameraAddress', 1);
  }

  private get transport(): Transport {
    return this.setting<string>('transport', 'udp').toLowerCase() === 'tcp' ? 'tcp' : 'udp';
  }

  private get framing(): Framing {
    const set = this.setting<string>('framing', '').toLowerCase();
    if (set === 'ip' || set === 'raw') return set;
    return this.transport === 'tcp' ? 'raw' : 'ip';
  }

  private get port() {
    return this.setting<number>('port', this.transport === 'tcp' ? 5678 : 52381);
  }

  override start() {
    const host = this.setting<string>('host', '');
    if (!host) return;
    this.running = true;
    if (this.transport === 'udp') {
      const socket = createSocket('udp4');
      this.socket = socket;
      socket.on('message', (msg) => this.onDatagram(msg));
      socket.on('error', () => undefined);
      // A fresh session: the camera forgets sequence numbers and drops anything left over.
      if (this.framing === 'ip') socket.send(packet(TYPE_RESET, 0, [0x01]), this.port, host, () => undefined);
    }
    void this.refresh();
    this.poller = setInterval(() => void this.refresh(), this.setting<number>('pollMs', 10_000));
    this.poller.unref?.();
  }

  override close() {
    this.running = false;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.failPending(new Error('closed'));
    this.socket?.close();
    this.socket = null;
    this.tcp?.destroy();
    this.tcp = null;
  }

  private failPending(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  private onDatagram(msg: Buffer) {
    if (this.framing === 'raw') return this.onMessage(RAW_KEY, msg);
    if (msg.length < 9) return;
    this.onMessage(msg.readUInt32BE(4), msg.subarray(8));
  }

  /** TCP is a stream: cut it into messages by the length in the header, or by the 0xFF that ends each raw one. */
  private onData(chunk: Buffer) {
    this.rx = Buffer.concat([this.rx, chunk]);
    if (this.framing === 'raw') {
      for (let end = this.rx.indexOf(0xff); end >= 0; end = this.rx.indexOf(0xff)) {
        const msg = this.rx.subarray(0, end + 1);
        this.rx = this.rx.subarray(end + 1);
        this.onMessage(RAW_KEY, msg);
      }
      if (this.rx.length > MAX_RAW_BYTES) this.rx = Buffer.alloc(0);
      return;
    }
    while (this.rx.length >= 8) {
      const length = this.rx.readUInt16BE(2);
      if (this.rx.length < 8 + length) break;
      const seq = this.rx.readUInt32BE(4);
      const payload = this.rx.subarray(8, 8 + length);
      this.rx = this.rx.subarray(8 + length);
      this.onMessage(seq, payload);
    }
  }

  private onMessage(key: number, payload: Buffer) {
    if (payload.length < 2) return;
    const p = this.pending.get(key);
    if (!p) return;
    if (p.done(payload)) {
      clearTimeout(p.timer);
      this.pending.delete(key);
      p.resolve(payload);
    }
  }

  /** The open TCP connection to the camera, made on first use and again after it drops. */
  private openTcp(): Promise<NetSocket> {
    if (this.tcp && !this.tcp.destroyed) return Promise.resolve(this.tcp);
    if (this.connecting) return this.connecting;
    const attempt = new Promise<NetSocket>((resolve, reject) => {
      const s = connect({ host: this.setting<string>('host', ''), port: this.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`${this.device.name} did not respond`));
      }, this.setting<number>('timeoutMs', 1500));
      s.setNoDelay(true);
      s.setKeepAlive(true, 10_000);
      s.once('connect', () => {
        clearTimeout(timer);
        this.rx = Buffer.alloc(0);
        this.tcp = s;
        resolve(s);
      });
      s.on('data', (chunk: Buffer) => this.onData(chunk));
      s.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      s.on('close', () => {
        clearTimeout(timer);
        reject(new Error(`${this.device.name} closed the connection`));
        if (this.tcp === s) {
          this.tcp = null;
          this.failPending(new Error(`${this.device.name} closed the connection`));
        }
      });
    });
    const shared = attempt.finally(() => {
      this.connecting = null;
    });
    this.connecting = shared;
    return shared;
  }

  private write(data: Buffer): Promise<void> {
    if (this.transport === 'tcp') {
      return this.openTcp().then(
        (s) =>
          new Promise<void>((resolve, reject) => s.write(data, (e) => (e ? reject(e) : resolve()))),
      );
    }
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error(`${this.device.name} is not running`));
    return new Promise((resolve, reject) =>
      socket.send(data, this.port, this.setting<string>('host', ''), (e) => (e ? reject(e) : resolve())),
    );
  }

  /** Sends one VISCA message and waits for the reply that finishes it (a completion, or an inquiry answer). */
  private exchange(type: number, payload: number[], finished: (p: Buffer) => boolean): Promise<Buffer> {
    if (!this.running) return Promise.reject(new Error(`${this.device.name} is not running`));
    // Replies carry no sequence number in raw framing, so they can only be told apart one at a time.
    if (this.framing !== 'raw') return this.exchangeNow(type, payload, finished);
    const run = this.chain.then(() => this.exchangeNow(type, payload, finished));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private exchangeNow(type: number, payload: number[], finished: (p: Buffer) => boolean): Promise<Buffer> {
    const raw = this.framing === 'raw';
    const key = raw ? RAW_KEY : this.seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`${this.device.name} did not respond`));
      }, this.setting<number>('timeoutMs', 1500));
      this.pending.set(key, {
        resolve,
        reject,
        timer,
        done: (p) => {
          // 0x6y is an error reply, which also ends the exchange.
          const kind = p[1]! & 0xf0;
          if (kind === 0x60) {
            clearTimeout(timer);
            this.pending.delete(key);
            reject(new Error(`${this.device.name} refused the command (error ${(p[2] ?? 0).toString(16)})`));
            return false;
          }
          return finished(p);
        },
      });
      this.write(raw ? Buffer.from(payload) : packet(type, key, payload)).catch((e: Error) => {
        clearTimeout(timer);
        if (this.pending.get(key)?.timer === timer) this.pending.delete(key);
        reject(e);
      });
    });
  }

  /** Power inquiry: proves the camera is there, and tells us whether it is on. */
  private async refresh() {
    if (this.busy || !this.running) return;
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
      case 'camera_move': {
        // Pan/tilt drive: speeds, then direction (01 left / 02 right / 03 stop, 01 up / 02 down / 03 stop).
        const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
        const pan = clamp(this.setting<number>('panSpeed', 12), 1, 24);
        const tilt = clamp(this.setting<number>('tiltSpeed', 10), 1, 20);
        const horizontal = command.pan < 0 ? 0x01 : command.pan > 0 ? 0x02 : 0x03;
        const vertical = command.tilt > 0 ? 0x01 : command.tilt < 0 ? 0x02 : 0x03;
        await this.exchange(TYPE_COMMAND, [a, 0x01, 0x06, 0x01, pan, tilt, horizontal, vertical, 0xff], completion);
        // Zoom: 00 stop, 2p variable tele (in), 3p variable wide (out).
        const speed = clamp(this.setting<number>('zoomSpeed', 3), 0, 7);
        const zoom = command.zoom > 0 ? 0x20 | speed : command.zoom < 0 ? 0x30 | speed : 0x00;
        await this.exchange(TYPE_COMMAND, [a, 0x01, 0x04, 0x07, zoom, 0xff], completion);
        this.update((s) => {
          s.online = true;
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
