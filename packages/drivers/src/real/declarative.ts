import { createSocket } from 'node:dgram';
import { connect, isIPv6, type Socket } from 'node:net';
import { request as httpsRequest } from 'node:https';
import {
  bytesToHex,
  commandValues,
  escapeJson,
  escapeLine,
  escapePath,
  hasCatastrophicBacktracking,
  hexFrame,
  renderTemplate,
  resolveSettings,
  type Device,
  type DeviceCommand,
  type DriverAction,
  type DriverSpec,
  type QuickActionId,
} from '@kestrel/model';
import { isLinkLocal, localAddressAllowed } from './address-guard';
import { BaseDriver } from './base';
import { Reconnect } from './reconnect';
import type { DriverContext } from './types';

// Runs a driver written in the Kestrel driver format (see @kestrel/model driver-spec). One
// interpreter for every third-party driver: what a driver can do is limited to what the format
// describes, so it can talk to its own device and nothing else.

const MAX_REPLY_BYTES = 64 * 1024;

type Values = Record<string, string | number | boolean>;

/**
 * Only the patterns that read feedback out of a line of text or a reply body. Saving a driver
 * already refuses a pattern shaped for catastrophic backtracking (driver-spec.ts), but a release
 * signed before that check existed could still carry one, so it is checked again here: skipped
 * (never run) rather than left free to hang the gateway on a line that almost, but does not
 * quite, match.
 */
function compile(spec: DriverSpec, log: DriverContext['log']) {
  return spec.feedback.patterns.flatMap((p) => {
    if (hasCatastrophicBacktracking(p.match)) {
      log('error', `Feedback pattern "${p.match}" could hang the gateway and was not loaded`, {
        driver: spec.id,
      });
      return [];
    }
    return [{ ...p, re: new RegExp(p.match) }];
  });
}

/** A safe `expect` regex, or null (never matches, never runs) for one that could hang the gateway. */
function safeExpect(
  source: string | undefined,
  spec: DriverSpec,
  log: DriverContext['log'],
): RegExp | null {
  if (!source) return null;
  if (hasCatastrophicBacktracking(source)) {
    log('error', `"expect" pattern "${source}" could hang the gateway and was not used`, {
      driver: spec.id,
    });
    return null;
  }
  return new RegExp(source);
}

export class DeclarativeDriver extends BaseDriver {
  private readonly settings: Values;
  private readonly missing: string[];
  private readonly patterns: ReturnType<typeof compile>;
  private socket: Socket | null = null;
  private ws: WebSocket | null = null;
  private buffer = '';
  private waiting: {
    re: RegExp | null;
    resolve: () => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  private pollers: ReturnType<typeof setInterval>[] = [];
  private readonly reconnect = new Reconnect(() => this.open());

  constructor(
    device: Device,
    ctx: DriverContext,
    private readonly spec: DriverSpec,
  ) {
    super(device, ctx);
    const r = resolveSettings(spec, device.settings);
    this.settings = r.values;
    this.missing = r.missing;
    this.patterns = compile(spec, ctx.log);
    this.state.online = false;
  }

  private get tcp() {
    return this.spec.transport.type === 'tcp' ? this.spec.transport : null;
  }
  private get http() {
    return this.spec.transport.type === 'http' ? this.spec.transport : null;
  }
  private get udp() {
    return this.spec.transport.type === 'udp' ? this.spec.transport : null;
  }
  private get wsSpec() {
    return this.spec.transport.type === 'websocket' ? this.spec.transport : null;
  }
  private get host() {
    return String(this.settings.host ?? '');
  }
  /** True if `host` is the gateway's own address and this device's settings do not allow that. */
  private blockedAddress(): boolean {
    // The escape hatch is read from the device's raw settings, not `this.settings`: only settings
    // the driver's own spec declares survive resolveSettings, and no driver declares this one.
    return !!this.host && isLinkLocal(this.host) && !localAddressAllowed(this.device.settings);
  }
  private get port() {
    const fromSetting = typeof this.settings.port === 'number' ? this.settings.port : undefined;
    const fallback = this.http
      ? this.http.https
        ? 443
        : 80
      : this.wsSpec
        ? this.wsSpec.secure
          ? 443
          : 80
        : 23;
    return fromSetting ?? this.spec.transport.port ?? fallback;
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
      this.ctx.log('warn', `Driver ${this.spec.id} is missing settings`, {
        device: this.device.name,
        missing: this.missing,
      });
      return;
    }
    if (this.blockedAddress()) {
      this.ctx.log(
        'error',
        `${this.device.name}'s address (${this.host}) is a cloud metadata address, not a device, and was refused`,
        {
          device: this.device.name,
          hint: 'Add "allowLocalAddress": true to this device’s settings if this is deliberate',
        },
      );
      return;
    }
    this.reconnect.restart();
    if (this.tcp) {
      if (this.tcp.keepOpen) this.open();
      else void this.probe();
    } else if (this.wsSpec) this.openWs();
    else void this.probe();
    for (const p of this.spec.feedback.poll)
      this.pollers.push(setInterval(() => void this.poll(p.action), p.everyMs));
    // The first poll is the reachability probe above. Any other poll (a slow one that reads the model
    // and serial number, say) also runs once now rather than after its first interval. A connection
    // that stays open runs them all when it connects.
    if (!this.tcp?.keepOpen && !this.wsSpec)
      for (const p of this.spec.feedback.poll.slice(1)) void this.poll(p.action);
    for (const t of this.pollers) t.unref?.();
  }

  override close() {
    for (const t of this.pollers) clearInterval(t);
    this.pollers = [];
    this.reconnect.stop();
    this.dropSocket(new Error('closed'));
  }

  /** Without a persistent connection, reachability is a plain connect (TCP) or the first poll (HTTP, UDP). */
  private async probe() {
    // UDP is connectionless: with nothing to poll there is nothing to prove, so the device stays
    // unknown until a command is answered.
    if (this.udp && !this.spec.feedback.poll[0]) return;
    try {
      if (this.tcp && !this.spec.feedback.poll[0]) await this.oneShot(null);
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

  /** Model, serial number and MAC the device has reported, by the feedback field that carried them. */
  private readonly identity = new Map<string, string>();

  private readText(text: string) {
    for (const p of this.patterns) {
      const m = p.re.exec(text);
      if (!m) continue;
      const raw = /^\$[1-9]$/.test(p.value) ? (m[Number(p.value.slice(1))] ?? '') : p.value;
      this.update((s) => {
        switch (p.set) {
          case 'power':
            s.power = /^(on|1|true)$/i.test(raw)
              ? 'on'
              : /^(off|0|false)$/i.test(raw)
                ? 'off'
                : s.power;
            break;
          case 'muted':
            s.muted = /^(on|1|true|muted)$/i.test(raw);
            break;
          case 'volume': {
            const n = Number(raw);
            const sc = this.spec.volumeScale;
            if (Number.isFinite(n))
              s.volume = Math.max(
                0,
                Math.min(100, Math.round(sc ? ((n - sc.min) / (sc.max - sc.min)) * 100 : n)),
              );
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
          case 'model':
          case 'serial':
          case 'mac': {
            // What the device says about itself goes to the register through the Identity section.
            const v = raw
              .replace(/[^\x20-\x7e]/g, '')
              .trim()
              .slice(0, 100);
            if (v) {
              this.identity.set(p.set, v);
              s.details = [
                {
                  title: 'Identity',
                  rows: (
                    [
                      ['model', 'Model'],
                      ['serial', 'Serial number'],
                      ['mac', 'MAC address'],
                    ] as const
                  ).flatMap(([k, label]) =>
                    this.identity.has(k) ? [{ label, value: this.identity.get(k)! }] : [],
                  ),
                },
              ];
            }
            break;
          }
          case 'firmware': {
            const version = raw
              .replace(/[^\x20-\x7e]/g, '')
              .trim()
              .slice(0, 100);
            if (version) s.firmware = version;
            break;
          }
        }
      });
    }
  }

  /** The device's settings as template values, so {setting.token} works everywhere. */
  private baseValues(): Values {
    return Object.fromEntries(Object.entries(this.settings).map(([k, v]) => [`setting.${k}`, v]));
  }

  private async pollOnce(action: DriverAction) {
    await this.dispatch(action, this.baseValues(), true);
  }

  /** Sends one action over whichever transport the driver speaks. */
  private async dispatch(action: DriverAction, values: Values, isPoll = false) {
    if (this.tcp) {
      if (this.tcp.keepOpen) await this.sendOnSocket(action, values);
      else await this.oneShot(action, values);
    } else if (this.udp) await this.udpSend(action, values, isPoll);
    else if (this.wsSpec) await this.sendOnWs(action, values);
    else this.readText(await this.httpCall(action, false, values));
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
    if (this.reconnect.closed || this.socket) return;
    const socket = connect({ host: this.host, port: this.port });
    this.socket = socket;
    if (!this.tcp?.binary) socket.setEncoding('utf8');
    socket.on('connect', () => {
      this.reconnect.succeeded();
      this.update((s) => {
        s.online = true;
      });
      // Say what the device is doing now, without waiting for the first interval.
      for (const p of this.spec.feedback.poll) void this.poll(p.action);
    });
    socket.on('data', (chunk: string | Buffer) => this.onData(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (this.socket === socket) this.dropSocket(new Error(`${this.device.name} disconnected`));
      this.reconnect.schedule();
    });
  }

  private dropSocket(reason: Error) {
    const socket = this.socket;
    const ws = this.ws;
    this.socket = null;
    this.ws = null;
    this.buffer = '';
    socket?.destroy();
    try {
      ws?.close();
    } catch {
      // already closed
    }
    for (const w of this.waiting.splice(0)) {
      clearTimeout(w.timer);
      w.reject(reason);
    }
    this.update((s) => {
      s.online = false;
    });
  }

  /** One binary reply (a chunk the device sent) as hex pairs, run past the patterns and the command waiting on it. */
  private onBinary(chunk: Buffer) {
    const frame = bytesToHex(chunk.subarray(0, MAX_REPLY_BYTES));
    this.readText(frame);
    const w = this.waiting[0];
    if (w && (!w.re || w.re.test(frame))) {
      this.waiting.shift();
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  private onData(chunk: string | Buffer) {
    if (typeof chunk !== 'string') return this.onBinary(chunk);
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

  /**
   * What goes on the wire for one action: its text and the transport's terminator, or its hex bytes
   * with the check byte worked out. A hex payload that does not come out as whole bytes is a driver
   * fault, not something to send.
   */
  private frame(action: DriverAction, values: Values, terminator: string): Buffer {
    if (action.hex === undefined) return Buffer.from(this.text(action, values) + terminator);
    // An input the driver has no code for would leave a gap in the frame, so it is refused instead.
    if (action.hex.includes('{inputCode}') && values.inputCode === undefined)
      throw new Error(`${this.device.name}: this driver has no code for that input`);
    const t = this.tcp ?? this.udp;
    const bytes = hexFrame(action.hex, values, t?.checksum);
    if (!bytes) throw new Error(`${this.device.name}: the driver's hex payload is not whole bytes`);
    return Buffer.from(bytes);
  }

  private sendOnSocket(action: DriverAction, values: Values): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed)
      return Promise.reject(new Error(`${this.device.name} is not connected`));
    const term = this.tcp!.terminator;
    const wait = new Promise<void>((resolve, reject) => {
      if (!action.expect) return resolve();
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w.timer !== timer);
        reject(new Error(`${this.device.name} did not answer`));
      }, this.tcp!.timeoutMs);
      this.waiting.push({
        re: safeExpect(action.expect, this.spec, this.ctx.log),
        resolve,
        reject,
        timer,
      });
    });
    socket.write(this.frame(action, values, term));
    return wait;
  }

  /** One connection per command, for devices that don't keep one open. */
  private oneShot(action: DriverAction | null, values: Values = {}): Promise<void> {
    const t = this.tcp!;
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const expect = safeExpect(action?.expect, this.spec, this.ctx.log);
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
      const timer = setTimeout(
        () => finish(new Error(`${this.device.name} did not respond`)),
        t.timeoutMs,
      );
      if (!t.binary) socket.setEncoding('utf8');
      socket.on('error', (e) => finish(new Error(`${this.device.name}: ${e.message}`)));
      socket.on('connect', () => {
        if (!action) return finish();
        let out: Buffer;
        try {
          out = this.frame(action, values, t.terminator);
        } catch (e) {
          return finish(e instanceof Error ? e : new Error(String(e)));
        }
        socket.write(out, (e) => {
          if (e) finish(e);
          else if (!expect && this.patterns.length === 0) finish();
        });
      });
      socket.on('data', (data: string | Buffer) => {
        if (typeof data !== 'string') {
          // Binary: each chunk is a reply, shown as hex pairs.
          const frame = bytesToHex(data.subarray(0, MAX_REPLY_BYTES));
          buffer = (buffer + ' ' + frame).trim().slice(-MAX_REPLY_BYTES);
          this.readText(frame);
          if (expect ? expect.test(frame) || expect.test(buffer) : this.patterns.length > 0)
            finish();
          return;
        }
        const chunk = data;
        buffer = (buffer + chunk).slice(-MAX_REPLY_BYTES);
        const replyEnd = t.replyTerminator ?? t.terminator;
        for (const line of buffer.split(replyEnd)) if (line) this.readText(line);
        const lines = buffer.split(replyEnd);
        if (
          expect
            ? lines.some((l) => expect.test(l))
            : this.patterns.length > 0 && buffer.includes(replyEnd)
        )
          finish();
      });
      socket.on('close', () => {
        const parts = t.binary ? [buffer] : buffer.split(t.replyTerminator ?? t.terminator);
        if (expect && !parts.some((l) => expect.test(l)))
          finish(new Error(`${this.device.name} sent an unexpected reply`));
        else finish();
      });
    });
  }

  // ---- UDP ------------------------------------------------------------------------------------

  /** One datagram out. Waits for a reply only when the action expects one, or for a poll that is read. */
  private udpSend(action: DriverAction, values: Values, isPoll: boolean): Promise<void> {
    const u = this.udp!;
    return new Promise((resolve, reject) => {
      const socket = createSocket(isIPv6(this.host) ? 'udp6' : 'udp4');
      const expect = safeExpect(action.expect, this.spec, this.ctx.log);
      const wantReply = !!action.expect || (isPoll && this.patterns.length > 0);
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(wantReply ? new Error(`${this.device.name} did not respond`) : undefined),
        u.timeoutMs,
      );
      socket.on('error', (e) => finish(new Error(`${this.device.name}: ${e.message}`)));
      socket.on('message', (msg) => {
        const reply = u.binary
          ? bytesToHex(msg.subarray(0, MAX_REPLY_BYTES))
          : msg.toString('utf8').slice(0, MAX_REPLY_BYTES);
        this.readText(reply);
        for (const line of reply.split(/\r?\n/)) if (line && line !== reply) this.readText(line);
        if (!expect || expect.test(reply)) finish();
      });
      let out: Buffer;
      try {
        out = this.frame(action, values, u.terminator);
      } catch (e) {
        return finish(e instanceof Error ? e : new Error(String(e)));
      }
      socket.send(out, this.port, this.host, (e) => {
        if (e) finish(e);
        else if (!wantReply) finish();
      });
    });
  }

  // ---- WebSocket ------------------------------------------------------------------------------

  private openWs() {
    const w = this.wsSpec;
    if (!w || this.reconnect.closed || this.ws) return;
    const base = this.baseValues();
    const path = renderTemplate(w.path, base, escapeLine);
    const url = `${w.secure ? 'wss' : 'ws'}://${this.host}:${this.port}${path}`;
    const headers = Object.fromEntries(
      Object.entries(w.headers).map(([k, v]) => [k, renderTemplate(v, base, escapeLine)]),
    );
    // Node's built-in WebSocket takes headers as an extra option that the standard type doesn't list.
    const Ctor = WebSocket as unknown as new (
      u: string,
      o?: { headers: Record<string, string> },
    ) => WebSocket;
    const ws = new Ctor(url, Object.keys(headers).length > 0 ? { headers } : undefined);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnect.succeeded();
      this.update((s) => {
        s.online = true;
      });
      for (const p of this.spec.feedback.poll) void this.poll(p.action);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') this.onWsMessage(ev.data.slice(0, MAX_REPLY_BYTES));
    };
    ws.onerror = () => undefined;
    ws.onclose = () => {
      if (this.ws === ws) this.dropSocket(new Error(`${this.device.name} disconnected`));
      this.reconnect.schedule();
    };
  }

  private onWsMessage(text: string) {
    if (!text) return;
    this.readText(text);
    const w = this.waiting[0];
    if (w && (!w.re || w.re.test(text))) {
      this.waiting.shift();
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  private sendOnWs(action: DriverAction, values: Values): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1)
      return Promise.reject(new Error(`${this.device.name} is not connected`));
    const wait = new Promise<void>((resolve, reject) => {
      if (!action.expect) return resolve();
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((x) => x.timer !== timer);
        reject(new Error(`${this.device.name} did not answer`));
      }, this.wsSpec!.timeoutMs);
      this.waiting.push({
        re: safeExpect(action.expect, this.spec, this.ctx.log),
        resolve,
        reject,
        timer,
      });
    });
    ws.send(this.text(action, values));
    return wait;
  }

  // ---- HTTP -----------------------------------------------------------------------------------

  private async httpCall(
    action: Pick<DriverAction, 'method' | 'path' | 'body' | 'expect' | 'headers'>,
    allowAny = false,
    values: Values = {},
  ): Promise<string> {
    const h = this.http!;
    const path = renderTemplate(action.path ?? '/', values, escapePath).replace(/^(?!\/)/, '/');
    const jsonBody =
      (action.body ?? '').trimStart().startsWith('{') ||
      (action.body ?? '').trimStart().startsWith('[');
    const body =
      action.body === undefined
        ? undefined
        : renderTemplate(action.body, values, jsonBody ? escapeJson : escapeLine);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...h.headers, ...action.headers }))
      headers[k] = renderTemplate(v, this.baseValues(), escapeLine);
    if (body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type'))
      headers['content-type'] = jsonBody ? 'application/json' : 'text/plain';
    const method = action.method ?? (body === undefined ? 'GET' : 'POST');
    // Most AV devices have a certificate of their own, so a driver can ask to accept it. fetch has no
    // way to do that, so this path uses the https module directly.
    const reply =
      h.https && h.allowSelfSigned
        ? await this.insecureHttps(path, method, headers, body, h.timeoutMs)
        : await (async () => {
            const res = await fetch(
              `${h.https ? 'https' : 'http'}://${this.host}:${this.port}${path}`,
              {
                method,
                headers,
                body,
                redirect: 'manual',
                signal: AbortSignal.timeout(h.timeoutMs),
              },
            );
            return {
              ok: res.ok,
              status: res.status,
              text: (await res.text()).slice(0, MAX_REPLY_BYTES),
            };
          })();
    const text = reply.text;
    if (!allowAny && !reply.ok)
      throw new Error(`${this.device.name} answered HTTP ${reply.status}`);
    const expect = safeExpect(action.expect, this.spec, this.ctx.log);
    if (expect && !expect.test(text))
      throw new Error(`${this.device.name} sent an unexpected reply`);
    return text;
  }

  private insecureHttps(
    path: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    timeoutMs: number,
  ): Promise<{ ok: boolean; status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          host: this.host,
          port: this.port,
          path,
          method,
          headers: {
            ...headers,
            ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
          },
          timeout: timeoutMs,
          rejectUnauthorized: false,
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (d: string) => {
            if (data.length < MAX_REPLY_BYTES) data += d;
          });
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            resolve({ ok: status >= 200 && status < 300, status, text: data.slice(0, MAX_REPLY_BYTES) });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`${this.device.name} did not respond`)));
      req.on('error', reject);
      req.end(body);
    });
  }

  // ---- Commands -------------------------------------------------------------------------------

  private async run(key: string, values: Values, apply: () => void): Promise<void> {
    const action = this.spec.commands[key];
    if (!action) this.fail(`does not support "${key}"`);
    if (this.blockedAddress())
      this.fail(
        `${this.host} is a cloud metadata address, not a device (add "allowLocalAddress": true to allow it)`,
      );
    try {
      await this.dispatch(action, values);
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
    const v = (input: Parameters<typeof commandValues>[2]) =>
      commandValues(this.spec, this.settings, input);
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
        return this.run(
          'route',
          v({ input: command.inputPortId, output: command.outputPortId }),
          () =>
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
