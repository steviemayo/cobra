import { connect, type Socket } from 'node:net';
import {
  pointFromLevel,
  pointToLevel,
  type ControlPoint,
  type Device,
  type DeviceCommand,
  type DeviceDetailSection,
  type DiscoveredComponent,
  type DiscoveredControl,
  type PointReading,
} from '@kestrel/model';
import { BaseDriver } from './base';
import { fetchCoreInfo } from './qsys-rest';
import { Reconnect } from './reconnect';
import type { DriverContext } from './types';

// Q-SYS Core over QRC (Q-SYS Remote Control): JSON-RPC 2.0 over TCP port 1710, every message ended
// by a null byte. The Core closes a connection that stays silent for 60 seconds, so the driver
// polls well inside that. The driver's own job is the connection: logon, keep-alive (`NoOp`), the
// engine status, and reconnecting. What to watch inside the Core is added as control points.
//
// Settings: host, port (1710), username, password (only if the Core requires a logon),
//   pollMs (2000 with control points, else 5000), timeoutMs (3000), snapshotBank (1) and
//   snapshotRamp (2 s) for presets. Older room designs may also set gainComponent, gainControl
//   ("gain"), muteControl ("mute"), minDb (-40) and maxDb (0): a gain component the panel volume
//   and mute act on, read on every poll. A device with no gainComponent reads no gain at all.
//
// Control points (docs/driver-classes.md): a point is a named component's control (address:
// component and control, for example a gain's "gain" and "mute", or a router's "select.2") or a named
// control on its own (address: control only; Boolean, Integer or Text, set valueType). They are read
// through ONE change group: `ChangeGroup.AddComponentControl` for each component's controls and
// `ChangeGroup.AddControl` for the named controls, then `ChangeGroup.Poll` on every tick, which
// answers with only what changed since the last poll (the first poll answers with everything). The
// group is built again after every reconnect, and when a poll says the Core no longer has it. A point
// with the role "room volume" or "room mute" is also what the panel volume and mute act on.
//
// Routing on a DSP is part of the Q-SYS design, so `route` and `power` are accepted and do nothing.
//
// Engine status: the Core pushes an unsolicited "EngineStatus" notification (no "id") as soon as a
// client connects, and again whenever it changes, so `onData` applies it as soon as it arrives.
// `onConnect` also asks for it directly with `StatusGet`, in case a particular Core or proxy only
// answers when asked. Either way it fills `details` (platform, design, redundancy, emulator, engine
// status) rather than `online`: a non-OK engine status (a bad compile, a missing licence) still means
// the Core answered, which is what `online` means everywhere else in this driver.
//
// Identity: QRC does not say what unit the Core is, so the driver also asks the Core's web interface
// (`GET /api/v0/cores/self`, qsys-rest.ts) for its model, serial number and firmware, once on every
// connect and then hourly. It logs on with the same name and password. The answer fills `firmware`
// and an Identity section in `details`, which feed the asset register. Settings: restPort (443),
// restProtocol (https; http for a Core behind a proxy) and allowSelfSigned (true: a Core's own
// certificate). A Core that does not answer there is still monitored; the reason is logged once.
//
// Discovery: `discoverComponents` (Component.GetComponents) and `discoverControls`
// (Component.GetControls) let the portal offer a pick-list when someone adds a control point,
// instead of them typing a component or control name blind (docs/driver-classes.md, "Where a vendor
// lets the device list its components, the form offers a pick-list").
const NUL = '\0';

interface Pending {
  resolve: (result: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface QrcControl {
  Name: string;
  Type?: string;
  Value?: number | boolean | string;
  ValueMin?: number;
  ValueMax?: number;
}

/** The Core answered, but with an error: it is reachable, whatever it thought of the request. */
class QrcError extends Error {}

/** One entry of a ChangeGroup.Poll answer: a named control, or a control of a named component. */
interface QrcChange {
  Component?: string;
  Name: string;
  Value?: number | boolean | string;
  String?: string;
}

interface QrcComponent {
  Name: string;
  Type?: string;
}

interface QrcEngineStatus {
  Platform?: string;
  State?: string;
  DesignName?: string;
  DesignCode?: string;
  IsRedundant?: boolean;
  IsEmulator?: boolean;
  Status?: { Code?: number; String?: string };
}

interface QrcReply {
  id?: number;
  /** Set on an unsolicited push (no "id"), for example "EngineStatus". */
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export class QsysDriver extends BaseDriver {
  private socket: Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private warnedReply = false;
  private readonly reconnect = new Reconnect(() => this.open());
  /** Goes up on every write, so a read that began before one is not allowed to overwrite it. */
  private writes = 0;
  /** True once this connection's change group is built; false after a drop or a Core that lost it. */
  private grouped = false;
  private warnedMissing = new Set<string>();
  /** The two sections of `details`: who the unit is (web interface) and how its engine is (QRC). */
  private identitySection: DeviceDetailSection | null = null;
  private engineSection: DeviceDetailSection | null = null;
  private inventoryAt = 0;
  private inventoryBusy = false;
  private inventoryDone = false;
  private warnedInventory = false;

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
  /** A point's component (blank for a named control on its own) and control. */
  private address(point: Pick<ControlPoint, 'address'>): { component: string; control: string } {
    const component = String(point.address.component ?? '');
    const control = String(point.address.control ?? '');
    if (!control) this.fail('the control point has no control name');
    return { component, control };
  }
  private get groupId() {
    return `kestrel-${this.device.id.slice(0, 8)}`;
  }
  /** The gain component older room designs read on every poll. Not set: none is read. */
  private get legacyGain() {
    return !!this.setting<string>('gainComponent', '');
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
    const every = Math.min(
      this.setting<number>('pollMs', this.points.length ? 2000 : 5000),
      30_000,
    );
    this.poller = setInterval(() => {
      void this.refresh();
      this.maybeLoadIdentity();
    }, every);
    this.poller.unref?.();
  }

  override close() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.reconnect.stop();
    // Tidy the change group while the connection is still there; the Core drops it anyway.
    if (this.grouped)
      void this.rpc('ChangeGroup.Destroy', { Id: this.groupId }).catch(() => undefined);
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
      try {
        // Usually redundant (the Core pushes this on connect unasked), but a direct ask is a
        // deterministic first read rather than a race with whether the push arrives.
        this.applyEngineStatus(await this.rpc('StatusGet', 0));
      } catch {
        // Some Cores or proxies only ever send it unsolicited; the push still updates details later.
      }
      await this.refresh(true);
      this.maybeLoadIdentity();
    } catch (e) {
      this.ctx.log('warn', 'Q-SYS logon failed', { device: this.device.name, error: String(e) });
      this.drop(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private drop(reason: Error) {
    const socket = this.socket;
    this.socket = null;
    this.grouped = false;
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
      if (msg.id === undefined) {
        if (msg.method === 'EngineStatus') this.applyEngineStatus(msg.params);
        continue; // an unsolicited notification, not a reply to anything pending
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error)
        p.reject(new QrcError(`${this.device.name}: ${msg.error.message ?? 'Q-SYS error'}`));
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

  /**
   * Builds the change group: one `ChangeGroup.AddComponentControl` per component and one
   * `ChangeGroup.AddControl` for every named control. A component or control the Core does not have
   * is left out (and logged once) so one wrong name does not stop the rest being read.
   */
  private async registerGroup() {
    const Id = this.groupId;
    await this.rpc('ChangeGroup.Destroy', { Id }).catch(() => undefined);
    const byComponent = new Map<string, Set<string>>();
    const named = new Set<string>();
    for (const p of this.points) {
      const { component, control } = this.address(p);
      if (component)
        byComponent.set(component, (byComponent.get(component) ?? new Set()).add(control));
      else named.add(control);
    }
    const tried = async (what: string, call: () => Promise<unknown>) => {
      try {
        await call();
      } catch (e) {
        if (!(e instanceof QrcError)) throw e;
        if (!this.warnedMissing.has(what)) {
          this.warnedMissing.add(what);
          this.ctx.log('warn', 'Q-SYS has no such control to watch', {
            device: this.device.name,
            what,
            error: String(e),
          });
        }
      }
    };
    for (const [component, controls] of byComponent)
      await tried(component, () =>
        this.rpc('ChangeGroup.AddComponentControl', {
          Id,
          Component: { Name: component, Controls: [...controls].map((Name) => ({ Name })) },
        }),
      );
    if (named.size)
      await tried('named controls', () =>
        this.rpc('ChangeGroup.AddControl', { Id, Controls: [...named] }),
      );
    this.grouped = true;
  }

  /** Asks the change group what changed. The first poll after building it answers with everything. */
  private async pollGroup() {
    const res = (await this.rpc('ChangeGroup.Poll', { Id: this.groupId })) as
      { Changes?: QrcChange[] } | undefined;
    const changes = res?.Changes ?? [];
    if (changes.length === 0) return;
    this.update((s) => {
      for (const c of changes) {
        const value = c.Value !== undefined ? c.Value : c.String;
        if (value === undefined) continue;
        for (const p of this.points) {
          const a = this.address(p);
          if (a.control !== c.Name || a.component !== (c.Component ?? '')) continue;
          s.points[p.id] = this.fromNative(p, value);
          if (p.role === 'room_volume' && typeof value === 'number')
            s.volume = pointToLevel(p, value);
          if (p.role === 'room_mute') s.muted = value === true || value === 1;
        }
      }
    });
  }

  private fromNative(p: ControlPoint, v: number | boolean | string): number | boolean | string {
    if (p.type === 'level') return typeof v === 'number' ? pointToLevel(p, v) : 0;
    if (p.type === 'mute') return v === true || v === 1;
    // A Q-SYS Boolean control answers 1 or 0 (or true or false) depending on how it is read.
    if (p.valueType === 'boolean') return v === true || v === 1 || v === 'true' || v === '1';
    if (
      (p.valueType === 'integer' || p.valueType === 'float') &&
      typeof v === 'string' &&
      v.trim() !== '' &&
      !Number.isNaN(Number(v))
    )
      return Number(v);
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
    if (component)
      await this.rpc('Component.Set', {
        Name: component,
        Controls: [{ Name: control, Value: this.toNative(p, value) }],
      });
    else await this.rpc('Control.Set', { Name: control, Value: this.toNative(p, value) });
    this.update((s) => {
      s.points[p.id] = p.type === 'mute' ? this.fromNative(p, this.toNative(p, value)) : value;
      if (p.role === 'room_volume') s.volume = Number(value);
      if (p.role === 'room_mute') s.muted = value === true;
    });
  }

  /** Applies an EngineStatus payload, from the unsolicited push or a direct StatusGet. */
  private applyEngineStatus(raw: unknown) {
    if (!raw || typeof raw !== 'object') return;
    const status = raw as QrcEngineStatus;
    const ok = status.Status?.Code === 0;
    const rows: DeviceDetailSection['rows'] = [];
    if (status.Platform) rows.push({ label: 'Platform', value: status.Platform });
    if (status.DesignName) rows.push({ label: 'Design', value: status.DesignName });
    if (status.DesignCode) rows.push({ label: 'Design code', value: status.DesignCode });
    if (status.State) rows.push({ label: 'State', value: status.State });
    if (status.IsRedundant !== undefined)
      rows.push({ label: 'Redundant', value: status.IsRedundant ? 'Yes' : 'No' });
    if (status.IsEmulator !== undefined)
      rows.push({ label: 'Emulator', value: status.IsEmulator ? 'Yes' : 'No' });
    if (status.Status?.String)
      rows.push({ label: 'Engine status', value: status.Status.String, status: ok ? 'ok' : 'bad' });
    this.update((s) => {
      // Receiving this at all proves the Core answered, whatever its own health says.
      s.online = true;
      this.engineSection = rows.length ? { title: 'Q-SYS Core', rows } : this.engineSection;
      const sections = this.sections();
      if (sections.length) s.details = sections;
    });
  }

  private sections(): DeviceDetailSection[] {
    return [this.identitySection, this.engineSection].filter((x): x is DeviceDetailSection => !!x);
  }

  /** Asks for the Core's identity on connect, retrying each minute until it answers, then hourly. */
  private maybeLoadIdentity() {
    if (!this.socket || this.inventoryBusy) return;
    if (Date.now() - this.inventoryAt < (this.inventoryDone ? 3_600_000 : 60_000)) return;
    void this.loadIdentity();
  }

  private async loadIdentity() {
    this.inventoryBusy = true;
    this.inventoryAt = Date.now();
    try {
      const flag = this.setting<boolean | string>('allowSelfSigned', true);
      const info = await fetchCoreInfo({
        host: this.setting<string>('host', ''),
        port: this.setting<number>('restPort', 443),
        https: this.setting<string>('restProtocol', 'https') !== 'http',
        allowSelfSigned: flag !== false && flag !== 'false',
        username: this.setting<string>('username', '') || undefined,
        password: this.setting<string>('password', '') || undefined,
        timeoutMs: Math.max(this.setting<number>('timeoutMs', 3000), 5000),
      });
      const rows: DeviceDetailSection['rows'] = [];
      if (info.model) rows.push({ label: 'Model', value: info.model });
      if (info.serial) rows.push({ label: 'Serial number', value: info.serial });
      if (info.firmware) rows.push({ label: 'Firmware', value: info.firmware });
      if (info.hostname) rows.push({ label: 'Hostname', value: info.hostname });
      if (info.hardwareId) rows.push({ label: 'Hardware ID', value: info.hardwareId });
      this.identitySection = rows.length ? { title: 'Identity', rows } : null;
      this.inventoryDone = true;
      this.warnedInventory = false;
      this.update((s) => {
        if (info.firmware) s.firmware = info.firmware;
        const sections = this.sections();
        if (sections.length) s.details = sections;
      });
    } catch (e) {
      // Monitoring carries on without it; say why once, not every minute.
      if (!this.warnedInventory) {
        this.warnedInventory = true;
        this.ctx.log('warn', 'Q-SYS Core did not give its model and serial number', {
          device: this.device.name,
          error: String(e),
        });
      }
    } finally {
      this.inventoryBusy = false;
    }
  }

  /** Lists the design's named components, for a pick-list instead of typing one blind. */
  async discoverComponents(): Promise<DiscoveredComponent[]> {
    const res = (await this.rpc('Component.GetComponents', {})) as QrcComponent[] | undefined;
    return (res ?? []).map((c) => ({ name: c.Name, ...(c.Type ? { type: c.Type } : {}) }));
  }

  /** Lists one named component's controls. */
  async discoverControls(component: string): Promise<DiscoveredControl[]> {
    const res = (await this.rpc('Component.GetControls', { Name: component })) as
      { Controls?: QrcControl[] } | undefined;
    return (res?.Controls ?? []).map((c) => ({
      name: c.Name,
      ...(c.Type ? { type: c.Type } : {}),
      ...(c.Value !== undefined ? { value: c.Value } : {}),
    }));
  }

  /** Reads one control point, to check it exists and learn its range. */
  async readPoint(
    point: Pick<ControlPoint, 'type' | 'address' | 'min' | 'max'>,
  ): Promise<PointReading> {
    const { component, control } = this.address(point);
    let found: QrcControl | undefined;
    if (component) {
      const res = (await this.rpc('Component.Get', {
        Name: component,
        Controls: [{ Name: control }],
      })) as { Controls?: QrcControl[] };
      found = (res.Controls ?? []).find((c) => c.Name === control);
    } else {
      // A named control on its own: Control.Get takes the names and answers with one entry each.
      const res = (await this.rpc('Control.Get', [control])) as QrcControl[] | undefined;
      found = (res ?? []).find((c) => c.Name === control);
    }
    if (!found || found.Value === undefined)
      this.fail(
        component
          ? `there is no control "${control}" on "${component}"`
          : `there is no named control "${control}"`,
      );
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
      if (this.points.length > 0) {
        if (!this.grouped) await this.registerGroup();
        await this.pollGroup();
      }
      if (this.usesPoints || !this.legacyGain) {
        // The poll is the keep-alive when there are points; with none, say NoOp.
        if (this.points.length === 0) await this.rpc('NoOp', {});
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
      // A Core that replies with an error (no such component, no such control) is up: the design just
      // lacks what was asked for. Only silence, or a lost connection, means it is not there.
      const reachable = e instanceof QrcError;
      // The Core answered but no longer has the change group (a design reload): build it again.
      if (reachable) this.grouped = false;
      if (first || (reachable && !this.warnedReply))
        this.ctx.log('warn', reachable ? 'Q-SYS answered with an error' : 'Q-SYS did not answer', {
          device: this.device.name,
          error: String(e),
        });
      if (reachable) this.warnedReply = true;
      this.update((s) => {
        s.online = reachable;
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
