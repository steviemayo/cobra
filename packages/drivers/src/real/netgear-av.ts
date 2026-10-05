import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type {
  ControlPoint,
  DetailStatus,
  Device,
  DeviceCommand,
  DeviceDetailSection,
  PointReading,
} from '@kestrel/model';
import { consoleAddressBlocked } from './ascii-console';
import { BaseDriver } from './base';
import type { DriverContext } from './types';

// The Netgear AV line managed switches (M4250, M4300 and their PoE variants) over the switch's own
// web API, the one its AV UI uses. It is richer than SNMP and needs nothing turned on: the switch
// answers it on the same ports as its web page (443, and 80). Read from the switch's own web
// application and checked against an M4250-26G4F-PoE+ on firmware 13.0.5.14 (2026-10-06).
//
//   POST /api/v1/login            { user: { name, password } } -> user.session
//   (every later request carries the token in a `session` header; a stale one is answered HTTP 403)
//   GET  /api/v1/device_info      model, firmware, serial number, MAC, uptime, fans, temperature, CPU, memory
//   GET  /api/v1/swcfg_poe_info   PoE budget and power in use (milliwatts)
//   GET  /api/v1/swcfg_ports_status?indexPage=1&pageSize=9999   every port: link, speed, name
//   GET  /api/v1/swcfg_poe?indexPage=1&pageSize=9999            every PoE port: state, class, power drawn (mW)
//   POST /api/v1/swcfg_poe_reset  { poePortConfig: { portId: [n] } }   power-cycle PoE on port n
//   GET  /api/v1/logout
//
// The driver keeps one login open and reuses it, signs in again when the switch says the token is
// stale, signs out when it stops, and after a refused login waits five minutes before trying again
// (so a wrong password cannot lock the account out).
//
// Control points: address { field } for the whole switch (temp, cpu, memory, poeUsedWatts,
// poeBudgetWatts) or { port, field } for a port (link, poe, poeWatts, poeEnabled).
//
// Command: `poe_cycle_<port>` turns PoE off and on again for that port, which reboots what it powers.
//
// Settings: host, port (443), https (true; the switch has its own certificate, which is accepted),
// username, password, pollMs (30000), timeoutMs (8000).

const MAX_BODY = 2 * 1024 * 1024;
/** After a refused login, how long before another attempt. */
export const LOGIN_BACKOFF_MS = 5 * 60_000;

interface Row {
  [key: string]: unknown;
}

export interface SwitchData {
  info?: Row;
  poeInfo?: Row;
  ports: Row[];
  poe: Row[];
}

class Refused extends Error {}
class StaleSession extends Error {}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const watts = (mw: unknown) => {
  const n = num(mw);
  return n === undefined ? undefined : Math.round(n / 100) / 10;
};

/** Ports that are real front-panel ports, not link aggregation groups ("0/26" is one, "lag 1" is not). */
const isPort = (r: Row) => /^\d+\/\d+$/.test(String(r.portStr ?? ''));

/** The first detail block of a unit (the switch's own, for a stack of one). */
const unitOf = (info?: Row) => (info?.details as Row[] | undefined)?.[0];

export function netgearDetails(d: SwitchData): DeviceDetailSection[] {
  const sections: DeviceDetailSection[] = [];
  const unit = unitOf(d.info);
  const identity: DeviceDetailSection['rows'] = [];
  const model = str(unit?.model);
  const serial = str(unit?.sn);
  const mac = str(d.info?.mac);
  if (model) identity.push({ label: 'Model', value: model });
  if (serial) identity.push({ label: 'Serial number', value: serial });
  if (mac) identity.push({ label: 'MAC address', value: mac });
  if (identity.length) sections.push({ title: 'Identity', rows: identity });

  const system: DeviceDetailSection['rows'] = [];
  const add = (label: string, value: string | undefined, status?: DetailStatus) => {
    if (value) system.push({ label, value: value.slice(0, 200), ...(status ? { status } : {}) });
  };
  add('Name', str(d.info?.name));
  add('Uptime', str(unit?.upTime));
  add('Boot version', str(unit?.bootVer));
  const sensors = (((d.info?.sensor as Row[] | undefined)?.[0]?.details as Row[]) ?? []).filter(
    (s) => num(s.temp) !== undefined,
  );
  for (const s of sensors) {
    const temp = num(s.temp)!;
    const max = num(s.maxTemp);
    add(
      String(s.desc ?? 'Sensor').replace(/^sensor-/i, 'Temperature '),
      `${temp} °C${max ? ` (limit ${max})` : ''}`,
      max ? (temp >= max ? 'bad' : temp >= max * 0.9 ? 'warning' : 'ok') : undefined,
    );
  }
  const fans = ((d.info?.fan as Row[] | undefined)?.[0]?.details as Row[]) ?? [];
  for (const f of fans)
    add(
      String(f.desc ?? 'Fan').replace(/^fan-/i, 'Fan '),
      `${num(f.speed) ?? '?'} rpm`,
      // 0 is a fan that is turning normally on every unit seen.
      num(f.state) === 0 ? 'ok' : 'warning',
    );
  add('CPU', str((d.info?.cpu as Row[] | undefined)?.[0]?.usage));
  add('Memory', str((d.info?.memory as Row[] | undefined)?.[0]?.usage));
  const front = d.ports.filter(isPort);
  if (front.length) add('Ports up', `${front.filter((p) => p.linkState === 0).length} of ${front.length}`);
  if (system.length) sections.push({ title: 'System', rows: system });

  const poeByPort = new Map(d.poe.map((p) => [String(p.portNum ?? p.port), p]));
  if (front.length)
    sections.push({
      title: 'Ports',
      rows: [],
      table: {
        columns: ['Port', 'Name', 'Link', 'Speed', 'PoE'],
        rows: front.slice(0, 128).map((p) => {
          const up = p.linkState === 0;
          const w = watts(poeByPort.get(String(p.portNum))?.currentPower);
          return {
            cells: [
              String(p.portStr),
              (str(p.description) ?? '').slice(0, 120),
              up ? 'Up' : 'Down',
              up ? (str(p.physicalStatus) ?? '') : '',
              w ? `${w} W` : '',
            ],
            ...(up ? { status: 'ok' as const } : {}),
          };
        }),
      },
    });

  if (d.poe.length || d.poeInfo) {
    const rows: DeviceDetailSection['rows'] = [];
    const total = watts(d.poeInfo?.totalPowerAvailable);
    const used = watts(d.poeInfo?.consumedPower);
    const threshold = watts(d.poeInfo?.thresholdPower);
    if (total !== undefined) rows.push({ label: 'PoE budget', value: `${total} W` });
    if (used !== undefined)
      rows.push({
        label: 'PoE in use',
        value: `${used} W`,
        ...(total && threshold !== undefined
          ? { status: (used >= total ? 'bad' : used >= threshold ? 'warning' : 'ok') as DetailStatus }
          : {}),
      });
    sections.push({
      title: 'PoE',
      rows,
      ...(d.poe.length
        ? {
            table: {
              columns: ['Port', 'Enabled', 'State', 'Power', 'Class'],
              rows: d.poe.slice(0, 128).map((p) => {
                const status = num(p.status);
                const w = watts(p.currentPower);
                return {
                  cells: [
                    String(p.port ?? p.portNum),
                    p.enable === true ? 'Yes' : 'No',
                    status === 2 ? 'Delivering power' : status === 1 ? 'Nothing powered' : `Status ${status ?? '?'}`,
                    w ? `${w} W` : '',
                    status === 2 ? `Class ${num(p.classification) ?? '?'}` : '',
                  ],
                  ...(status === 2 ? { status: 'ok' as const } : status !== 1 ? { status: 'warning' as const } : {}),
                };
              }),
            },
          }
        : {}),
    });
  }
  return sections;
}

/** What a control point reads from the switch, or undefined when the port or field is not there. */
export function netgearPoint(
  address: ControlPoint['address'],
  d: SwitchData,
): number | boolean | undefined {
  const field = String(address.field ?? '').toLowerCase();
  const port = address.port === undefined || address.port === '' ? undefined : String(address.port).trim();
  if (port === undefined) {
    const sensors = ((d.info?.sensor as Row[] | undefined)?.[0]?.details as Row[]) ?? [];
    switch (field) {
      case 'temp':
        return sensors.length ? Math.max(...sensors.map((s) => num(s.temp) ?? -Infinity)) : undefined;
      case 'cpu':
        return Number.parseFloat(String((d.info?.cpu as Row[] | undefined)?.[0]?.usage ?? '')) || undefined;
      case 'memory':
        return Number.parseFloat(String((d.info?.memory as Row[] | undefined)?.[0]?.usage ?? '')) || undefined;
      case 'poeusedwatts':
        return watts(d.poeInfo?.consumedPower);
      case 'poebudgetwatts':
        return watts(d.poeInfo?.totalPowerAvailable);
      default:
        return undefined;
    }
  }
  const link = d.ports.find((p) => isPort(p) && String(p.portNum) === port);
  const poe = d.poe.find((p) => String(p.portNum ?? p.port) === port);
  switch (field) {
    case 'link':
      return link ? link.linkState === 0 : undefined;
    case 'poe':
      return poe ? num(poe.status) === 2 : undefined;
    case 'poewatts':
      return poe ? watts(poe.currentPower) : undefined;
    case 'poeenabled':
      return poe ? poe.enable === true : undefined;
    default:
      return undefined;
  }
}

export class NetgearAvDriver extends BaseDriver {
  private poller: ReturnType<typeof setInterval> | null = null;
  private session: string | null = null;
  private blockedUntil = 0;
  private data: SwitchData = { ports: [], poe: [] };
  private polling = false;

  constructor(device: Device, ctx: DriverContext) {
    super(device, ctx);
    this.state.online = false;
  }

  override features(): string[] {
    return ['http_health'];
  }

  private get https() {
    return this.setting<boolean>('https', true) !== false;
  }

  private target() {
    const host = this.setting<string>('host', '');
    if (!host) this.fail('no host configured');
    if (consoleAddressBlocked(host, this.device.settings))
      this.fail(`${host} is a cloud metadata address, not a device (add "allowLocalAddress": true to allow it)`);
    return { host, port: this.setting<number>('port', this.https ? 443 : 80) };
  }

  private call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    session?: string,
  ): Promise<{ status: number; json: Row | null }> {
    const t = this.target();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = (this.https ? httpsRequest : httpRequest)(
        {
          host: t.host,
          port: t.port,
          path,
          method,
          headers: {
            accept: 'application/json',
            'cache-control': 'no-cache',
            ...(payload !== undefined
              ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
              : {}),
            ...(session ? { session } : {}),
          },
          timeout: this.setting<number>('timeoutMs', 8000),
          ...(this.https ? { rejectUnauthorized: false } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY) return req.destroy(new Error('the reply was too large'));
            chunks.push(c);
          });
          res.on('end', () => {
            const parse = (): Row | null => {
              try {
                return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Row;
              } catch {
                return null;
              }
            };
            resolve({ status: res.statusCode ?? 0, json: parse() });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('did not respond')));
      req.on('error', reject);
      req.end(payload);
    });
  }

  private async login(): Promise<string> {
    if (Date.now() < this.blockedUntil)
      throw new Refused('the login was refused recently, so it is not being tried again yet');
    const res = await this.call('POST', '/api/v1/login', {
      user: { name: this.setting<string>('username', 'admin'), password: this.setting<string>('password', '') },
    });
    const token = str((res.json?.user as Row | undefined)?.session);
    if (!token) {
      this.blockedUntil = Date.now() + LOGIN_BACKOFF_MS;
      throw new Refused(str((res.json?.resp as Row | undefined)?.respMsg) ?? 'the login was refused');
    }
    this.session = token;
    return token;
  }

  /** A GET with the open login, signing in first (or again once if the switch says it is stale). */
  private async get(path: string): Promise<Row> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const session = this.session ?? (await this.login());
      const res = await this.call('GET', path, undefined, session);
      if (res.status === 403 || res.status === 401) {
        this.session = null;
        continue;
      }
      if (res.status !== 200 || !res.json) throw new Error(`answered HTTP ${res.status}`);
      const code = num((res.json.resp as Row | undefined)?.respCode);
      if (code !== undefined && code !== 0)
        throw new Error(str((res.json.resp as Row).respMsg) ?? `answered code ${code}`);
      return res.json;
    }
    throw new StaleSession('could not keep a login open');
  }

  override start() {
    if (!this.setting<string>('host', '')) return;
    void this.poll();
    this.poller = setInterval(() => void this.poll(), this.setting<number>('pollMs', 30000));
    this.poller.unref?.();
  }

  override close() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    // Leave no session behind on the switch; it only holds a few.
    const session = this.session;
    this.session = null;
    if (session) void this.call('GET', '/api/v1/logout', undefined, session).catch(() => undefined);
  }

  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const info = await this.get('/api/v1/device_info');
      const poeInfo = await this.get('/api/v1/swcfg_poe_info').catch(() => null);
      const ports = await this.get('/api/v1/swcfg_ports_status?indexPage=1&pageSize=9999');
      const poe = await this.get('/api/v1/swcfg_poe?indexPage=1&pageSize=9999').catch(() => null);
      this.data = {
        info: (info.deviceInfo as Row | undefined) ?? undefined,
        poeInfo: (poeInfo?.poeInfo as Row[] | undefined)?.[0],
        ports: ((ports.switchPortStatus as Row | undefined)?.rows as Row[] | undefined) ?? [],
        poe: (poe?.poePortConfig as Row[] | undefined) ?? [],
      };
      const points: Record<string, number | boolean> = {};
      for (const p of this.device.points ?? []) {
        const v = netgearPoint(p.address, this.data);
        if (v !== undefined) points[p.id] = v;
      }
      const firmware = str(unitOf(this.data.info)?.fwVer);
      this.update((s) => {
        s.online = true;
        s.points = points as never;
        if (firmware) s.firmware = firmware.slice(0, 100);
        s.details = netgearDetails(this.data);
      });
    } catch (e) {
      this.ctx.log('warn', `${this.device.name}: ${e instanceof Error ? e.message : String(e)}`);
      this.update((s) => {
        s.online = false;
      });
    } finally {
      this.polling = false;
    }
  }

  async readPoint(point: Pick<ControlPoint, 'type' | 'address' | 'min' | 'max'>): Promise<PointReading> {
    const v = netgearPoint(point.address, this.data);
    if (v === undefined) this.fail('that port or reading was not found');
    return { value: v };
  }

  async send(command: DeviceCommand): Promise<void> {
    if (command.type !== 'command') this.fail(`does not support "${command.type}"`);
    const m = /^poe_cycle_(\d{1,3})$/.exec(command.name);
    if (!m) this.fail(`does not support "${command.name}"`);
    const port = Number(m[1]);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const session = this.session ?? (await this.login());
        const res = await this.call('POST', '/api/v1/swcfg_poe_reset', { poePortConfig: { portId: [port] } }, session);
        if (res.status === 403 || res.status === 401) {
          this.session = null;
          continue;
        }
        const code = num((res.json?.resp as Row | undefined)?.respCode);
        if (res.status !== 200 || code !== 0)
          throw new Error(str((res.json?.resp as Row | undefined)?.respMsg) ?? `answered HTTP ${res.status}`);
        setTimeout(() => void this.poll(), 6000).unref?.();
        return;
      }
      throw new Error('could not keep a login open');
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }
}
