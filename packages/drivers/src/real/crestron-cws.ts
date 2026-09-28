import http from 'node:http';
import https from 'node:https';
import type {
  ControlPoint,
  Device,
  DeviceCommand,
  DeviceState,
  PointReading,
} from '@kestrel/model';
import { BaseDriver } from './base';
import { isRecord } from './nvx';
import type { DriverContext } from './types';

// The Crestron "CresNext" CWS REST API, shared by DM-NVX (see nvx.ts), 4-series control processors
// (RMC4, MC4, CP4, ...) and TSW/TS touch panels: a single cookie-authenticated web server exposing
// its whole configuration as one JSON tree at GET /Device. Verified against real RMC4 and TS-1070
// units: log in by POSTing `login=<u>&&passwd=<p>` to /userlogin.html (Origin and Referer headers
// set to the device's own URL; the device answers 403 without them) and keep the cookies it sets;
// an expired session on a 4-series/panel unit shows up as a 301/302 redirect back to
// /userlogin.html, not the 401 NVX itself answers with, so both are treated as "log in again".

/**
 * Reads a dotted path out of a parsed `/Device` tree, e.g.
 * "Device.Programs.ProgramInstanceLibrary.DeviceSlot1.IpTable.Entries.3.Status". Numeric path
 * segments also index into an array.
 */
export function digPath(tree: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, key) => {
    if (isRecord(o)) return o[key];
    if (Array.isArray(o) && /^\d+$/.test(key)) return o[Number(key)];
    return undefined;
  }, tree);
}

/** One CresNext unit: logs in once, keeps its cookies, logs in again when the session is rejected. */
export class CrestronCwsSession {
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
    return new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
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
            resolve({
              status: res.statusCode ?? 0,
              location: res.headers.location,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
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

  private needsLogin(res: { status: number; location?: string }): boolean {
    if (res.status === 401 || res.status === 403) return true;
    return (res.status === 301 || res.status === 302) && !!res.location?.includes('userlogin');
  }

  async get(path: string): Promise<unknown> {
    let res = await this.request('GET', path);
    if (this.needsLogin(res)) {
      await this.login();
      res = await this.request('GET', path);
    }
    if (res.status < 200 || res.status >= 300)
      throw new Error(`GET ${path} answered HTTP ${res.status}`);
    try {
      return res.body.trim() ? JSON.parse(res.body) : undefined;
    } catch {
      throw new Error(`GET ${path} did not answer JSON`);
    }
  }
}

/**
 * Shared machinery for a monitoring-only CresNext device (4-series processor, touch panel): one
 * GET /Device per poll, resolved against any control points the room configured (each addressed by
 * a dotted `path` into that tree), plus whatever else a subclass wants to read from the same tree.
 * Never sends anything: these are watched, not driven.
 */
export abstract class CrestronCwsMonitor extends BaseDriver {
  private session: CrestronCwsSession | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(device: Device, ctx: DriverContext) {
    super(device, ctx);
    this.state.online = false;
  }

  protected get points(): ControlPoint[] {
    return this.device.points ?? [];
  }

  private ensureSession(): CrestronCwsSession {
    if (!this.session) {
      const protocol = this.setting<'http' | 'https'>('protocol', 'https');
      this.session = new CrestronCwsSession(this.setting<string>('host', ''), {
        protocol,
        port: this.setting<number>('port', protocol === 'http' ? 80 : 443),
        username: this.setting<string>('username', 'admin'),
        password: this.setting<string>('password', ''),
        timeoutMs: this.setting<number>('timeoutMs', 4000),
        allowSelfSigned: this.setting<boolean>('allowSelfSigned', true),
      });
    }
    return this.session;
  }

  private pointPath(point: Pick<ControlPoint, 'address'>): string | undefined {
    const path = point.address.path;
    return typeof path === 'string' ? path : undefined;
  }

  /** Every configured point's value, read from an already-fetched tree. */
  private readPoints(tree: unknown): Record<string, number | boolean | string> {
    const values: Record<string, number | boolean | string> = {};
    for (const p of this.points) {
      const path = this.pointPath(p);
      if (!path) continue;
      const v = digPath(tree, path);
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        values[p.id] = v;
    }
    return values;
  }

  /** What a subclass reads from the tree beyond online/points (firmware, power, activeApp, ...). */
  protected abstract applyFeedback(tree: unknown, s: DeviceState): void;

  override start() {
    if (!this.setting<string>('host', '')) return;
    void this.refresh();
    this.poller = setInterval(() => void this.refresh(), this.setting<number>('pollMs', 15000));
    this.poller.unref?.();
  }

  override close() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.session?.close();
    this.session = null;
  }

  private async refresh() {
    if (this.busy) return;
    this.busy = true;
    try {
      const tree = await this.ensureSession().get('/Device');
      const points = this.readPoints(tree);
      this.update((s) => {
        s.online = true;
        s.points = points;
        this.applyFeedback(tree, s);
      });
    } catch {
      this.update((s) => {
        s.online = false;
      });
    } finally {
      this.busy = false;
    }
  }

  async readPoint(
    point: Pick<ControlPoint, 'type' | 'address' | 'min' | 'max'>,
  ): Promise<PointReading> {
    const path = this.pointPath(point);
    if (!path) this.fail('this point has no path set');
    const v = digPath(await this.ensureSession().get('/Device'), path);
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean')
      this.fail(`"${path}" was not found`);
    return { value: v };
  }

  async send(command: DeviceCommand): Promise<void> {
    this.fail(`does not support "${command.type}" (monitoring only)`);
  }
}
