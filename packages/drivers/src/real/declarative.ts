import { connect, type Socket } from 'node:net';
import {
  commandValues,
  escapeJson,
  escapeLine,
  escapePath,
  renderTemplate,
  resolveSettings,
  type Device,
  type DeviceCommand,
  type DriverAction,
  type DriverSpec,
  type QuickActionId,
} from '@kestrel/model';
import { BaseDriver } from './base';
import type { DriverContext } from './types';

// Runs a driver written in the Kestrel driver format (see @kestrel/model driver-spec). One
// interpreter for every third-party driver: what a driver can do is limited to what the format
// describes, so it can talk to its own device and nothing else.

const MAX_REPLY_BYTES = 64 * 1024;
const MAX_BACKOFF_MS = 15_000;

type Values = Record<string, string | number | boolean>;

/** Only the patterns that read feedback out of a line of text or a reply body. */
function compile(spec: DriverSpec) {
  return spec.feedback.patterns.map((p) => ({ ...p, re: new RegExp(p.match) }));
}

export class DeclarativeDriver extends BaseDriver {
  private readonly settings: Values;
  private readonly missing: string[];
  private readonly patterns: ReturnType<typeof compile>;
  private socket: Socket | null = null;
  private buffer = '';
  private waiting: { re: RegExp | null; resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private pollers: ReturnType<typeof setInterval>[] = [];
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private closed = false;

  constructor(
    device: Device,
    ctx: DriverContext,
    private readonly spec: DriverSpec,
  ) {
    super(device, ctx);
    const r = resolveSettings(spec, device.settings);
    this.settings = r.values;
    this.missing = r.missing;
    this.patterns = compile(spec);
    this.state.online = false;
  }

  private get tcp() {
    return this.spec.transport.type === 'tcp' ? this.spec.transport : null;
  }
  private get http() {
    return this.spec.transport.type === 'http' ? this.spec.transport : null;
  }
  private get host() {
    return String(this.settings.host ?? '');
  }
  private get port() {
    const fromSetting = typeof this.settings.port === 'number' ? this.settings.port : undefined;
    return fromSetting ?? this.spec.transport.port ?? (this.http?.https ? 443 : this.http ? 80 : 23);
  }

  override features(): string[] {
    return [...(this.spec.features ?? [])];
  }

  /** The quick actions the driver declares. Others are refused by the room, not offered. */
  override quickActions(): QuickActionId[] {
    return [...new Set(this.spec.quickActions ?? [])];
  }

  // ---- Lifecycle ------------------------------------------------------------------------------

  override start() {
    if (this.missing.length > 0) {
      this.ctx.log('warn', `Driver ${this.spec.id} is missing settings`, { device: this.device.name, missing: this.missing });
      return;
    }
    this.closed = false;
    if (this.tcp) {
      if (this.tcp.keepOpen) this.open();
      else void this.probe();
    } else void this.probe();
    for (const p of this.spec.feedback.poll)
      this.pollers.push(setInterval(() => void this.poll(p.action), p.everyMs));
    for (const t of this.pollers) t.unref?.();
  }

  override close() {
    this.closed = true;
    for (const t of this.pollers) clearInterval(t);
    this.pollers = [];
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.dropSocket(new Error('closed'));
  }

  /** Without a persistent connection, reachability is a plain connect (TCP) or the first poll (HTTP). */
  private async probe() {
    try {
      if (this.tcp) await this.oneShot(null);
      else if (this.spec.feedback.poll[0]) await this.pollOnce(this.spec.feedback.poll[0].action);
      else await this.httpCall({ method: 'GET', path: '/' }, true);
      this.update((s) => {
        s.online = true;
      });
    } catch {
      this.update((s) => {
        s.online = false;
      });
    }
  }

  // ---- Feedback -------------------------------------------------------------------------------

  private readText(text: string) {
    for (const p of this.patterns) {
      const m = p.re.exec(text);
      if (!m) continue;
      const raw = /^\$[1-9]$/.test(p.value) ? (m[Number(p.value.slice(1))] ?? '') : p.value;
      this.update((s) => {
        switch (p.set) {
          case 'power':
            s.power = /^(on|1|true)$/i.test(raw) ? 'on' : /^(off|0|false)$/i.test(raw) ? 'off' : s.power;
            break;
          case 'muted':
            s.muted = /^(on|1|true|muted)$/i.test(raw);
            break;
          case 'volume': {
            const n = Number(raw);
            const sc = this.spec.volumeScale;
            if (Number.isFinite(n))
              s.volume = Math.max(0, Math.min(100, Math.round(sc ? ((n - sc.min) / (sc.max - sc.min)) * 100 : n)));
            break;
          }
          case 'input':
            s.selectedInput = raw || null;
            break;
          case 'preset':
            s.preset = raw;
            break;
          case 'blanked':
            s.blanked = /^(on|1|true|blank|blanked)$/i.test(raw);
            break;
          case 'online':
            s.online = /^(on|1|true)$/i.test(raw);
            break;
        }
      });
    }
  }

  /** The device's settings as template values, so {setting.token} works everywhere. */
  private baseValues(): Values {
    return Object.fromEntries(Object.entries(this.settings).map(([k, v]) => [`setting.${k}`, v]));
  }

  private async pollOnce(action: DriverAction) {
    const values = this.baseValues();
    if (this.tcp) {
      if (this.tcp.keepOpen) await this.sendOnSocket(action, values);
      else await this.oneShot(action, values);
    } else this.readText(await this.httpCall(action, false, values));
  }

  private async poll(action: DriverAction) {
    try {
      await this.pollOnce(action);
      this.update((s) => {
        s.online = true;
      });
    } catch {
      this.update((s) => {
        s.online = false;
      });
    }
  }

  // ---- TCP ------------------------------------------------------------------------------------

  private open() {
    if (this.closed || this.socket) return;
    const socket = connect({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      this.retries = 0;
      this.update((s) => {
        s.online = true;
      });
      // Say what the device is doing now, without waiting for the first interval.
      for (const p of this.spec.feedback.poll) void this.poll(p.action);
    });
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (this.socket === socket) this.dropSocket(new Error(`${this.device.name} disconnected`));
      if (this.closed || this.retry) return;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.retries++, 4));
      this.retry = setTimeout(() => {
        this.retry = null;
        this.open();
      }, delay);
      this.retry.unref?.();
    });
  }

  private dropSocket(reason: Error) {
    const socket = this.socket;
    this.socket = null;
    this.buffer = '';
    socket?.destroy();
    for (const w of this.waiting.splice(0)) {
      clearTimeout(w.timer);
      w.reject(reason);
    }
    this.update((s) => {
      s.online = false;
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_REPLY_BYTES) this.buffer = this.buffer.slice(-MAX_REPLY_BYTES);
    const term = this.tcp?.replyTerminator ?? this.tcp?.terminator ?? '\r\n';
    let i: number;
    while ((i = this.buffer.indexOf(term)) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + term.length);
      if (!line) continue;
      this.readText(line);
      const w = this.waiting[0];
      if (w && (!w.re || w.re.test(line))) {
        this.waiting.shift();
        clearTimeout(w.timer);
        w.resolve();
      }
    }
  }

  private text(action: DriverAction, values: Values) {
    return renderTemplate(action.send ?? '', values, escapeLine);
  }

  private sendOnSocket(action: DriverAction, values: Values): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error(`${this.device.name} is not connected`));
    const term = this.tcp!.terminator;
    const wait = new Promise<void>((resolve, reject) => {
      if (!action.expect) return resolve();
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w.timer !== timer);
        reject(new Error(`${this.device.name} did not answer`));
      }, this.tcp!.timeoutMs);
      this.waiting.push({ re: new RegExp(action.expect), resolve, reject, timer });
    });
    socket.write(this.text(action, values) + term);
    return wait;
  }

  /** One connection per command, for devices that don't keep one open. */
  private oneShot(action: DriverAction | null, values: Values = {}): Promise<void> {
    const t = this.tcp!;
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const expect = action?.expect ? new RegExp(action.expect) : null;
      let buffer = '';
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error(`${this.device.name} did not respond`)), t.timeoutMs);
      socket.setEncoding('utf8');
      socket.on('error', (e) => finish(new Error(`${this.device.name}: ${e.message}`)));
      socket.on('connect', () => {
        if (!action) return finish();
        socket.write(this.text(action, values) + t.terminator, (e) => {
          if (e) finish(e);
          else if (!expect && this.patterns.length === 0) finish();
        });
      });
      socket.on('data', (chunk: string) => {
        buffer = (buffer + chunk).slice(-MAX_REPLY_BYTES);
        const replyEnd = t.replyTerminator ?? t.terminator;
        for (const line of buffer.split(replyEnd)) if (line) this.readText(line);
        const lines = buffer.split(replyEnd);
        if (expect ? lines.some((l) => expect.test(l)) : this.patterns.length > 0 && buffer.includes(replyEnd)) finish();
      });
      socket.on('close', () => {
        if (expect && !buffer.split(t.replyTerminator ?? t.terminator).some((l) => expect.test(l)))
          finish(new Error(`${this.device.name} sent an unexpected reply`));
        else finish();
      });
    });
  }

  // ---- HTTP -----------------------------------------------------------------------------------

  private async httpCall(action: Pick<DriverAction, 'method' | 'path' | 'body' | 'expect' | 'headers'>, allowAny = false, values: Values = {}): Promise<string> {
    const h = this.http!;
    const path = renderTemplate(action.path ?? '/', values, escapePath).replace(/^(?!\/)/, '/');
    const jsonBody = (action.body ?? '').trimStart().startsWith('{') || (action.body ?? '').trimStart().startsWith('[');
    const body = action.body === undefined ? undefined : renderTemplate(action.body, values, jsonBody ? escapeJson : escapeLine);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...h.headers, ...action.headers }))
      headers[k] = renderTemplate(v, this.baseValues(), escapeLine);
    if (body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type'))
      headers['content-type'] = jsonBody ? 'application/json' : 'text/plain';
    const url = `${h.https ? 'https' : 'http'}://${this.host}:${this.port}${path}`;
    const res = await fetch(url, {
      method: action.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(h.timeoutMs),
    });
    const text = (await res.text()).slice(0, MAX_REPLY_BYTES);
    if (!allowAny && !res.ok) throw new Error(`${this.device.name} answered HTTP ${res.status}`);
    if (action.expect && !new RegExp(action.expect).test(text)) throw new Error(`${this.device.name} sent an unexpected reply`);
    return text;
  }

  // ---- Commands -------------------------------------------------------------------------------

  private async run(key: string, values: Values, apply: () => void): Promise<void> {
    const action = this.spec.commands[key];
    if (!action) this.fail(`does not support "${key}"`);
    try {
      if (this.tcp) {
        if (this.tcp.keepOpen) await this.sendOnSocket(action, values);
        else await this.oneShot(action, values);
      } else this.readText(await this.httpCall(action, false, values));
    } catch (e) {
      this.update((s) => {
        s.online = false;
      });
      throw e;
    }
    this.update((s) => {
      s.online = true;
    });
    apply();
  }

  async send(command: DeviceCommand): Promise<void> {
    const v = (input: Parameters<typeof commandValues>[2]) => commandValues(this.spec, this.settings, input);
    switch (command.type) {
      case 'power':
        return this.run(`power.${command.on ? 'on' : 'off'}`, v({}), () =>
          this.update((s) => {
            s.power = command.on ? 'on' : 'off';
            if (!command.on) s.blanked = false;
          }),
        );
      case 'blank':
        return this.run(`blank.${command.on ? 'on' : 'off'}`, v({}), () =>
          this.update((s) => {
            s.blanked = command.on;
          }),
        );
      case 'mute':
        return this.run(`mute.${command.muted ? 'on' : 'off'}`, v({}), () =>
          this.update((s) => {
            s.muted = command.muted;
          }),
        );
      case 'volume':
        return this.run('volume', v({ level: command.level }), () =>
          this.update((s) => {
            s.volume = command.level;
          }),
        );
      case 'select_input':
        return this.run('select_input', v({ input: command.portId }), () =>
          this.update((s) => {
            s.selectedInput = command.portId;
          }),
        );
      case 'route':
        return this.run('route', v({ input: command.inputPortId, output: command.outputPortId }), () =>
          this.update((s) => {
            s.routes[command.outputPortId] = command.inputPortId;
          }),
        );
      case 'preset':
        return this.run('preset', v({ name: command.name }), () =>
          this.update((s) => {
            s.preset = command.name;
          }),
        );
      case 'camera_preset':
        return this.run('camera_preset', v({ name: command.name }), () => undefined);
      case 'scene':
        return this.run('scene', v({ name: command.name }), () => undefined);
      case 'record':
        return this.run(`record.${command.on ? 'on' : 'off'}`, v({}), () =>
          this.update((s) => {
            s.recording = command.on;
          }),
        );
      case 'key':
        return this.run(`key.${command.key}`, v({}), () => undefined);
      case 'launch_app':
        return this.run('app.launch', v({ appId: command.appId }), () =>
          this.update((s) => {
            s.activeApp = command.appId;
          }),
        );
      case 'command':
        return this.run(`command.${command.name}`, v({}), () => undefined);
    }
  }
}
