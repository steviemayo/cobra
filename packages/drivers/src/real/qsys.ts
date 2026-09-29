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
import { Reconnect } from './reconnect';
import type { DriverContext } from './types';

// Q-SYS Core over QRC (Q-SYS Remote Control): JSON-RPC 2.0 over TCP port 1710, every message ended
// by a null byte. The Core closes a connection that stays silent for 60 seconds, so the driver
// polls the gain component (which also refreshes what the panel shows) well inside that.
//
// Settings: host, port (1710), username, password (only if the Core requires a logon),
//   gainComponent ("gain"), gainControl ("gain"), muteControl ("mute"),
//   minDb (-40) and maxDb (0): the volume scale, 0-100 on the panel is minDb-maxDb on the Core,
//   snapshotBank (1) and snapshotRamp (2 s) for presets, pollMs (5000), timeoutMs (3000).
//
// Control points: a device can also list named controls to drive (docs/driver-classes.md). A point's
// address is a component and a control. A point with the role "room volume" or "room mute" is what
// the panel volume and mute act on; without one, the gain component above is used (as before).
//
// Routing on a DSP is part of the Q-SYS design, so `route` and `power` are accepted and do nothing.
const NUL = '\0';

interface Pending {
  resolve: (result: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface QrcControl {
  Name: string;
  Value?: number | boolean | string;
  ValueMin?: number;
  ValueMax?: number;
}

interface QrcReply {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export class QsysDriver extends BaseDriver {
  private socket: Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private readonly reconnect = new Reconnect(() => this.open());
  /** Goes up on every write, so a read that began before one is not allowed to overwrite it. */
  private writes = 0;

  constructor(device: Device, ctx: DriverContext) {
    super(device, ctx);
    this.state.online = false;
  }

  private get gain() {
    return this.setting<string>('gainComponent', 'gain');
  }
  private get minDb() {
    return this.setting<number>('minDb', -40);
  }
  private get maxDb() {
    return this.setting<number>('maxDb', 0);
  }

  private get points(): ControlPoint[] {
    return this.device.points ?? [];
  }
  private roleOf(role: ControlPoint['role']) {
    return this.points.find((p) => p.role === role);
  }
  private address(point: Pick<ControlPoint, 'address'>): { component: string; control: string } {
    const component = String(point.address.component ?? '');
    const control = String(point.address.control ?? '');
    if (!component || !control) this.fail('the control point has no component and control');
    return { component, control };
  }
  /** Room volume and mute come from points when there are some, else from the gain component. */
  private get usesPoints() {
    return !!(this.roleOf('room_volume') || this.roleOf('room_mute'));
  }

  private toDb(level: number): number {
    return Math.round((this.minDb + (level / 100) * (this.maxDb - this.minDb)) * 10) / 10;
  }
  private toLevel(db: number): number {
    const span = this.maxDb - this.minDb;
    return span === 0
      ? 0
      : Math.max(0, Math.min(100, Math.round(((db - this.minDb) / span) * 100)));
  }

  // ---- Connection -----------------------------------------------------------------------------

  override start() {
    if (!this.setting<string>('host', '')) return;
    this.reconnect.restart();
    this.open();
    const every = Math.min(this.setting<number>('pollMs', 5000), 30_000);
    this.poller = setInterval(() => void this.refresh(), every);
    this.poller.unref?.();
  }

  override close() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.reconnect.stop();
    this.drop(new Error('closed'));
  }

  private open() {
    if (this.reconnect.closed || this.socket) return;
    const socket = connect({
      host: this.setting<string>('host', ''),
      port: this.setting<number>('port', 1710),
    });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 15_000);
    socket.on('connect', () => void this.onConnect());
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (this.socket === socket) this.drop(new Error(`${this.device.name} disconnected`));
      this.reconnect.schedule();
    });
  }

  private async onConnect() {
    try {
      const user = this.setting<string>('username', '');
      if (user)
        await this.rpc('Logon', { User: user, Password: this.setting<string>('password', '') });
      this.reconnect.succeeded();
      await this.refresh(true);
    } catch (e) {
      this.ctx.log('warn', 'Q-SYS logon failed', { device: this.device.name, error: String(e) });
      this.drop(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private drop(reason: Error) {
    const socket = this.socket;
    this.socket = null;
    this.buffer = '';
    socket?.destroy();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(reason);
      this.pending.delete(id);
    }
    this.update((s) => {
      s.online = false;
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf(NUL)) >= 0) {
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!raw.trim()) continue;
      let msg: QrcReply;
      try {
        msg = JSON.parse(raw) as QrcReply;
      } catch {
        continue;
      }
      const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
      if (!p || msg.id === undefined) continue; // notifications such as EngineStatus
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error)
        p.reject(new Error(`${this.device.name}: ${msg.error.message ?? 'Q-SYS error'}`));
      else p.resolve(msg.result);
    }
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed)
      return Promise.reject(new Error(`${this.device.name} is not connected`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error(`${this.device.name} did not respond`));
        },
        this.setting<number>('timeoutMs', 3000),
      );
      this.pending.set(id, { resolve, reject, timer });
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + NUL);
    });
  }

  /** Reads every control point, one request per component. */
  private async readPoints() {
    const byComponent = new Map<string, ControlPoint[]>();
    for (const p of this.points) {
      const { component } = this.address(p);
      byComponent.set(component, [...(byComponent.get(component) ?? []), p]);
    }
    for (const [component, points] of byComponent) {
      const epoch = this.writes;
      const res = (await this.rpc('Component.Get', {
        Name: component,
        Controls: points.map((p) => ({ Name: this.address(p).control })),
      })) as { Controls?: QrcControl[] };
      if (this.writes !== epoch) continue; // something was set while this was being read: the read is stale
      const byName = new Map((res.Controls ?? []).map((c) => [c.Name, c.Value]));
      this.update((s) => {
        for (const p of points) {
          const v = byName.get(this.address(p).control);
          if (v === undefined) continue;
          s.points[p.id] = this.fromNative(p, v);
          if (p.role === 'room_volume' && typeof v === 'number') s.volume = pointToLevel(p, v);
          if (p.role === 'room_mute') s.muted = v === true || v === 1;
        }
      });
    }
  }

  private fromNative(p: ControlPoint, v: number | boolean | string): number | boolean | string {
    if (p.type === 'level') return typeof v === 'number' ? pointToLevel(p, v) : 0;
    if (p.type === 'mute') return v === true || v === 1;
    return v;
  }

  private toNative(p: ControlPoint, value: number | boolean | string): number | string {
    if (p.type === 'level') return pointFromLevel(p, Number(value));
    if (p.type === 'mute') return value === true || value === 1 || value === 'true' ? 1 : 0;
    return typeof value === 'boolean' ? (value ? 1 : 0) : value;
  }

  private async setPoint(p: ControlPoint, value: number | boolean | string) {
    this.writes++;
    if (p.type === 'meter') this.fail('a meter is read only');
    const { component, control } = this.address(p);
    await this.rpc('Component.Set', { Name: component, Controls: [{ Name: control, Value: this.toNative(p, value) }] });
    this.update((s) => {
      s.points[p.id] = p.type === 'mute' ? this.fromNative(p, this.toNative(p, value)) : value;
      if (p.role === 'room_volume') s.volume = Number(value);
      if (p.role === 'room_mute') s.muted = value === true;
    });
  }

  /** Reads one control point, to check it exists and learn its range. */
  async readPoint(point: Pick<ControlPoint, 'type' | 'address' | 'min' | 'max'>): Promise<PointReading> {
    const { component, control } = this.address(point);
    const res = (await this.rpc('Component.Get', { Name: component, Controls: [{ Name: control }] })) as {
      Controls?: QrcControl[];
    };
    const found = (res.Controls ?? []).find((c) => c.Name === control);
    if (!found || found.Value === undefined) this.fail(`there is no control "${control}" on "${component}"`);
    const value = found.Value;
    if (point.type === 'level')
      return {
        value: typeof value === 'number' ? value : 0,
        ...(typeof found.ValueMin === 'number' ? { min: found.ValueMin } : {}),
        ...(typeof found.ValueMax === 'number' ? { max: found.ValueMax } : {}),
      };
    return { value: point.type === 'mute' ? value === true || value === 1 : value };
  }

  /** Reads the gain component. Doubles as the keep-alive. */
  private async refresh(first = false) {
    if (!this.socket) return;
    try {
      if (this.points.length > 0) await this.readPoints();
      if (this.usesPoints) {
        this.update((s) => {
          s.online = true;
        });
        return;
      }
      const res = (await this.rpc('Component.Get', {
        Name: this.gain,
        Controls: [
          { Name: this.setting<string>('gainControl', 'gain') },
          { Name: this.setting<string>('muteControl', 'mute') },
        ],
      })) as { Controls?: { Name: string; Value?: number | boolean }[] };
      const byName = new Map((res.Controls ?? []).map((c) => [c.Name, c.Value]));
      const db = byName.get(this.setting<string>('gainControl', 'gain'));
      const muted = byName.get(this.setting<string>('muteControl', 'mute'));
      this.update((s) => {
        s.online = true;
        if (typeof db === 'number') s.volume = this.toLevel(db);
        if (muted !== undefined) s.muted = muted === true || muted === 1;
      });
    } catch (e) {
      if (first)
        this.ctx.log('warn', 'Q-SYS did not answer', {
          device: this.device.name,
          error: String(e),
        });
      this.update((s) => {
        s.online = false;
      });
    }
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
        const roomVolume = this.roleOf('room_volume');
        if (roomVolume) return this.setPoint(roomVolume, command.level);
        await this.rpc('Component.Set', {
          Name: this.gain,
          Controls: [
            { Name: this.setting<string>('gainControl', 'gain'), Value: this.toDb(command.level) },
          ],
        });
        this.update((s) => {
          s.volume = command.level;
        });
        return;
      }
      case 'mute': {
        const roomMute = this.roleOf('room_mute');
        if (roomMute) return this.setPoint(roomMute, command.muted);
        await this.rpc('Component.Set', {
          Name: this.gain,
          Controls: [
            { Name: this.setting<string>('muteControl', 'mute'), Value: command.muted ? 1 : 0 },
          ],
        });
        this.update((s) => {
          s.muted = command.muted;
        });
        return;
      }
      case 'preset': {
        await this.rpc('Snapshot.Load', {
          Name: command.name,
          Bank: this.setting<number>('snapshotBank', 1),
          Ramp: this.setting<number>('snapshotRamp', 2),
        });
        this.update((s) => {
          s.preset = command.name;
        });
        return;
      }
      case 'command': {
        // command.control.<Named Control> sets any named control on the Core.
        const m = /^control\.(.+)$/.exec(command.name);
        if (!m) this.fail(`unknown command "${command.name}"`);
        await this.rpc('Control.Set', { Name: m[1], Value: command.args.value });
        return;
      }
      case 'power':
      case 'route':
      case 'select_input':
        // Fixed by the Q-SYS design, not by Kestrel.
        return;
      default:
        this.fail(`does not support "${command.type}"`);
    }
  }
}
