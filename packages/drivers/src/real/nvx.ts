import http from 'node:http';
import https from 'node:https';
import type { Device, DeviceCommand } from '@kestrel/model';
import { BaseDriver } from './base';
import type { DriverContext } from './types';

// Crestron DM-NVX as a virtual video matrix. The room's matrix device stands for a set of NVX
// endpoints: each input port is an encoder (E30, ...) and each output port a decoder (D30, ...).
// Routing an input to an output points the decoder at the encoder's stream, using the DM NVX REST
// API (CresNext) over HTTPS with the device's own login.
//
// Settings:
//   username, password           the NVX logon (authentication is on by default)
//   inputs:  { "<input port id>":  { "host": "10.0.0.11" } }     encoders
//   outputs: { "<output port id>": { "host": "10.0.0.12" } }     decoders
//   (an endpoint may also give its own "port")
//   protocol ("https"), port (443), allowSelfSigned (true: NVX ships with a self-signed
//   certificate), pollMs (5000), timeoutMs (4000)
//
// Wire details, from the DM NVX REST API manual: log in by POSTing `login=<u>&&passwd=<p>` to
// /userlogin.html and keep the cookies it sets; read with GET /Device/<Object>; write with
// POST /Device and a partial {"Device": {...}} body; a negative StatusId in the reply is a failure.

interface Endpoint {
  host: string;
  port?: number;
}
type Dict = Record<string, unknown>;

const isRecord = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v);

/** One NVX unit: logs in once, keeps its cookies, logs in again if it is told to (401). */
class NvxSession {
  private cookies = new Map<string, string>();
  private readonly agent: http.Agent | https.Agent;

  constructor(
    private readonly host: string,
    private readonly o: {
      protocol: 'http' | 'https';
      port: number;
      username: string;
      password: string;
      timeoutMs: number;
      allowSelfSigned: boolean;
    },
  ) {
    this.agent =
      o.protocol === 'https'
        ? new https.Agent({ keepAlive: true, rejectUnauthorized: !o.allowSelfSigned })
        : new http.Agent({ keepAlive: true });
  }

  close() {
    this.agent.destroy();
  }

  private request(method: 'GET' | 'POST', path: string, body?: string, type = 'application/json') {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const headers: Record<string, string | number> = {
        Referer: `${this.o.protocol}://${this.host}/`,
        Origin: `${this.o.protocol}://${this.host}`,
      };
      if (this.cookies.size)
        headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body !== undefined) {
        headers['Content-Type'] = type;
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      const lib = this.o.protocol === 'https' ? https : http;
      const req = lib.request(
        {
          host: this.host,
          port: this.o.port,
          path,
          method,
          headers,
          agent: this.agent,
          timeout: this.o.timeoutMs,
        },
        (res) => {
          for (const raw of res.headers['set-cookie'] ?? []) {
            const pair = raw.split(';', 1)[0]!;
            const eq = pair.indexOf('=');
            if (eq > 0) this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
          }
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  private async login() {
    this.cookies.clear();
    await this.request('GET', '/userlogin.html');
    const form = `login=${encodeURIComponent(this.o.username)}&&passwd=${encodeURIComponent(this.o.password)}`;
    const res = await this.request(
      'POST',
      '/userlogin.html',
      form,
      'application/x-www-form-urlencoded',
    );
    if (res.status !== 200 && res.status !== 302)
      throw new Error(`login refused (HTTP ${res.status})`);
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let res = await this.request(method, path, payload);
    if (res.status === 401 || res.status === 403) {
      await this.login();
      res = await this.request(method, path, payload);
    }
    if (res.status < 200 || res.status >= 300)
      throw new Error(`${method} ${path} answered HTTP ${res.status}`);
    let json: unknown;
    try {
      json = res.body.trim() ? JSON.parse(res.body) : undefined;
    } catch {
      json = undefined;
    }
    if (method === 'POST' && isRecord(json) && Array.isArray(json.Actions))
      for (const a of json.Actions)
        for (const r of isRecord(a) && Array.isArray(a.Results) ? a.Results : [])
          if (isRecord(r) && Number(r.StatusId) < 0)
            throw new Error(
              `${String(r.Path ?? r.Property ?? path)}: ${String(r.StatusInfo ?? r.StatusId)}`,
            );
    return json;
  }

  get(path: string) {
    return this.call('GET', path);
  }
  set(device: Dict) {
    return this.call('POST', '/Device', { Device: device });
  }
}

const dig = (v: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((o, k) => (isRecord(o) ? o[k] : undefined), v);

export class NvxDriver extends BaseDriver {
  private readonly sessions = new Map<string, NvxSession>();
  private readonly streamIds = new Map<string, string>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(device: Device, ctx: DriverContext) {
    super(device, ctx);
    this.state.online = false;
  }

  private endpoints(kind: 'inputs' | 'outputs'): Map<string, Endpoint> {
    const raw = this.setting<Record<string, Endpoint>>(kind, {});
    return new Map(
      Object.entries(raw).filter(([, e]) => isRecord(e) && typeof e.host === 'string' && e.host),
    );
  }

  private session(e: Endpoint): NvxSession {
    const protocol = this.setting<'http' | 'https'>('protocol', 'https');
    const port = e.port ?? this.setting<number>('port', protocol === 'http' ? 80 : 443);
    const key = `${e.host}:${port}`;
    let s = this.sessions.get(key);
    if (!s) {
      s = new NvxSession(e.host, {
        protocol,
        port,
        username: this.setting<string>('username', 'admin'),
        password: this.setting<string>('password', ''),
        timeoutMs: this.setting<number>('timeoutMs', 4000),
        allowSelfSigned: this.setting<boolean>('allowSelfSigned', true),
      });
      this.sessions.set(key, s);
    }
    return s;
  }

  override start() {
    if (this.endpoints('inputs').size + this.endpoints('outputs').size === 0) return;
    void this.refresh();
    this.poller = setInterval(() => void this.refresh(), this.setting<number>('pollMs', 5000));
    this.poller.unref?.();
  }

  override close() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  /** The id an encoder's stream is known by, which is what a decoder is pointed at. */
  private async streamId(e: Endpoint, fresh = false): Promise<string> {
    const host = `${e.host}:${e.port ?? ''}`;
    const cached = this.streamIds.get(host);
    if (cached && !fresh) return cached;
    const streams = dig(
      await this.session(e).get('/Device/StreamTransmit'),
      'Device',
      'StreamTransmit',
      'Streams',
    );
    const first = Array.isArray(streams) ? streams.find(isRecord) : undefined;
    const id = first && (first.UUID ?? first.Uuid ?? first.UniqueId);
    if (typeof id !== 'string' || !id) throw new Error(`${e.host} did not report a stream`);
    this.streamIds.set(host, id);
    return id;
  }

  /** Reads every endpoint: which encoder each decoder shows, and whether each encoder has a signal. */
  private async refresh() {
    if (this.busy) return;
    this.busy = true;
    try {
      const inputs = this.endpoints('inputs');
      const outputs = this.endpoints('outputs');
      const byStream = new Map<string, string>();
      const signal: Record<string, boolean> = {};
      const routes: Record<string, string | null> = {};
      let allUp = true;

      await Promise.all([
        ...[...inputs].map(async ([port, e]) => {
          try {
            byStream.set(await this.streamId(e, true), port);
            const ports = dig(
              await this.session(e).get('/Device/AudioVideoInputOutput'),
              'Device',
              'AudioVideoInputOutput',
              'Inputs',
            );
            const first = Array.isArray(ports) ? ports.find(isRecord) : undefined;
            const p = first && Array.isArray(first.Ports) ? first.Ports.find(isRecord) : undefined;
            if (p && typeof p.IsSyncDetected === 'boolean') signal[port] = p.IsSyncDetected;
          } catch {
            allUp = false;
          }
        }),
        ...[...outputs].map(async ([port, e]) => {
          try {
            const r = dig(
              await this.session(e).get('/Device/AvRouting'),
              'Device',
              'AvRouting',
              'Routes',
            );
            const first = Array.isArray(r) ? r.find(isRecord) : undefined;
            routes[port] = typeof first?.VideoSource === 'string' ? first.VideoSource : null;
          } catch {
            allUp = false;
          }
        }),
      ]);

      this.update((s) => {
        s.online = allUp;
        if (allUp) {
          s.signal = signal;
          s.routes = Object.fromEntries(
            Object.entries(routes).map(([out, src]) => [out, (src && byStream.get(src)) || null]),
          );
        }
      });
    } finally {
      this.busy = false;
    }
  }

  async send(command: DeviceCommand): Promise<void> {
    switch (command.type) {
      case 'route': {
        const enc = this.endpoints('inputs').get(command.inputPortId);
        const dec = this.endpoints('outputs').get(command.outputPortId);
        if (!enc) this.fail(`input ${command.inputPortId} has no encoder configured`);
        if (!dec) this.fail(`output ${command.outputPortId} has no decoder configured`);
        try {
          const set = async (fresh: boolean) => {
            const id = await this.streamId(enc, fresh);
            await this.session(dec).set({
              AvRouting: { Routes: [{ VideoSource: id, AudioSource: id }] },
            });
          };
          // A cached stream id can go stale if the encoder was replaced: look it up again once.
          await set(false).catch(() => set(true));
        } catch (e) {
          this.update((s) => {
            s.online = false;
          });
          this.fail(e instanceof Error ? e.message : String(e));
        }
        this.update((s) => {
          s.online = true;
          s.routes[command.outputPortId] = command.inputPortId;
        });
        return;
      }
      case 'power':
      case 'select_input':
        return;
      default:
        this.fail(`does not support "${command.type}"`);
    }
  }
}
