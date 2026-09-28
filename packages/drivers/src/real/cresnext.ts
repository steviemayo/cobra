import http from 'node:http';
import https from 'node:https';

// The Crestron "CresNext" web services (CWS), shared by DM-NVX, 4-series control processors,
// TSW/TS touch panels and occupancy sensors: one cookie-authenticated web server exposing the
// device's configuration as a JSON tree at GET /Device.
//
// Login, verified against real RMC4 and TS-1070 units: POST `login=<u>&&passwd=<p>` to
// /userlogin.html with Origin and Referer set to the device's own URL (403 without them) and keep
// the cookies it sets. An expired session shows up as 401/403, or as a 301/302 redirect back to
// /userlogin.html (4-series and panels), and either way means "log in again".
// Writes are POST /Device with a partial {"Device": {...}} body; a negative StatusId in the reply
// is a failure. `GET /Device/[Object]/Longpoll` (or /Device/Longpoll) returns when something
// changed, or on the device's own timeout, and must then be asked again.

type Dict = Record<string, unknown>;

export const isRecord = (v: unknown): v is Dict =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export const dig = (v: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((o, k) => (isRecord(o) ? o[k] : undefined), v);

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

export interface CresNextOptions {
  protocol: 'http' | 'https';
  port: number;
  username: string;
  password: string;
  timeoutMs: number;
  allowSelfSigned: boolean;
}

interface Response {
  status: number;
  location?: string;
  body: string;
}

/** One CresNext unit: logs in once, keeps its cookies, logs in again when the session is rejected. */
export class CresNextSession {
  private cookies = new Map<string, string>();
  private readonly agent: http.Agent | https.Agent;
  private closed = false;

  constructor(
    private readonly host: string,
    private readonly o: CresNextOptions,
  ) {
    this.agent =
      o.protocol === 'https'
        ? new https.Agent({ keepAlive: true, rejectUnauthorized: !o.allowSelfSigned })
        : new http.Agent({ keepAlive: true });
  }

  close() {
    this.closed = true;
    this.agent.destroy();
  }

  private request(
    method: 'GET' | 'POST',
    path: string,
    body?: string,
    type = 'application/json',
    timeoutMs = this.o.timeoutMs,
  ) {
    return new Promise<Response>((resolve, reject) => {
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
          timeout: timeoutMs,
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

  private needsLogin(res: Response): boolean {
    if (res.status === 401 || res.status === 403) return true;
    return (res.status === 301 || res.status === 302) && !!res.location?.includes('userlogin');
  }

  private parse(res: Response, what: string): unknown {
    if (res.status < 200 || res.status >= 300)
      throw new Error(`${what} answered HTTP ${res.status}`);
    try {
      return res.body.trim() ? JSON.parse(res.body) : undefined;
    } catch {
      throw new Error(`${what} did not answer JSON`);
    }
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<Response> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let res = await this.request(method, path, payload, 'application/json', timeoutMs);
    if (this.needsLogin(res)) {
      await this.login();
      res = await this.request(method, path, payload, 'application/json', timeoutMs);
    }
    return res;
  }

  async get(path: string): Promise<unknown> {
    return this.parse(await this.call('GET', path), `GET ${path}`);
  }

  async set(device: Dict): Promise<unknown> {
    const path = '/Device';
    const json = this.parse(await this.call('POST', path, { Device: device }), `POST ${path}`);
    if (isRecord(json) && Array.isArray(json.Actions))
      for (const a of json.Actions)
        for (const r of isRecord(a) && Array.isArray(a.Results) ? a.Results : [])
          if (isRecord(r) && Number(r.StatusId) < 0)
            throw new Error(
              `${String(r.Path ?? r.Property ?? path)}: ${String(r.StatusInfo ?? r.StatusId)}`,
            );
    return json;
  }

  /**
   * Waits for the device to say something changed. Resolves with the changed part of the tree, or
   * `null` when the device's own timeout passed with nothing to report (ask again). Rejects when
   * the device does not support long polls at this path, or cannot be reached.
   */
  async longpoll(path = '/Device/Longpoll', waitMs = 70_000): Promise<unknown | null> {
    if (this.closed) return null;
    const res = await this.call('GET', path, undefined, waitMs).catch((e: unknown) => {
      if (e instanceof Error && e.message === 'timed out') return null;
      throw e;
    });
    if (!res) return null;
    if (res.status === 204 || res.status === 408 || res.status === 504) return null;
    const json = this.parse(res, `GET ${path}`);
    return isRecord(json) && Object.keys(json).length === 0 ? null : (json ?? null);
  }
}
