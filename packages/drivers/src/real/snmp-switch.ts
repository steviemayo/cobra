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
import { SnmpClient, indexOf, type VarBind } from './snmp';
import type { DriverContext } from './types';

// A network switch (or any SNMP device) as a monitored device: whether it answers, who it is, which
// ports are up, and PoE. Written for the Netgear AV line (M4250, M4300), which implements the
// standard MIBs below, and it works the same for any other switch, access point or UPS that does.
//
//   SNMPv2-MIB    system name, description, uptime, location
//   IF-MIB        ports: name, link up or down, speed
//   ENTITY-MIB    model, serial number and software version of the chassis
//   POWER-ETHERNET-MIB (RFC 3621)  PoE: each port's admin state and detection status, the whole
//                 supply's power and consumption
//
// Control points: any value by its OID, address { oid }, read with a GET (a number comes back as a
// number, text as text), so a UPS's battery charge or a switch's temperature can be watched and
// alerted on. Also a port, address { port: "12", field: "link" } (up is true) or { port: "1.5",
// field: "poe" } (true when delivering power; "1.5" is group.port as the PoE MIB numbers it).
//
// Commands (PoE only, and only with a write community): `poe_off_<group>_<port>`,
// `poe_on_<group>_<port>` and `poe_cycle_<group>_<port>`, which turns the port off, waits cycleMs
// (5000) and turns it on. That is how a stuck PoE device (an access point, a camera) is rebooted.
//
// SNMPv2c only: the community string is not encrypted. Settings: host, port (161), community
// (public), writeCommunity, pollMs (30000), timeoutMs (3000), cycleMs (5000).
//
// Not yet checked against a real switch.

const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  sysLocation: '1.3.6.1.2.1.1.6.0',
  ifDescr: '1.3.6.1.2.1.2.2.1.2',
  ifType: '1.3.6.1.2.1.2.2.1.3',
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
  ifName: '1.3.6.1.2.1.31.1.1.1.1',
  ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15',
  ifAlias: '1.3.6.1.2.1.31.1.1.1.18',
  entSoftwareRev: '1.3.6.1.2.1.47.1.1.1.1.10',
  entSerial: '1.3.6.1.2.1.47.1.1.1.1.11',
  entModel: '1.3.6.1.2.1.47.1.1.1.1.13',
  pethAdmin: '1.3.6.1.2.1.105.1.1.1.3',
  pethDetection: '1.3.6.1.2.1.105.1.1.1.6',
  pethMainPower: '1.3.6.1.2.1.105.1.3.1.1.2',
  pethMainOper: '1.3.6.1.2.1.105.1.3.1.1.3',
  pethMainUsed: '1.3.6.1.2.1.105.1.3.1.1.4',
} as const;

const PORT_TYPES = new Set([6, 117]); // ethernetCsmacd, gigabitEthernet
const DETECTION = [
  '',
  'Off',
  'Searching',
  'Delivering power',
  'Fault',
  'Test',
  'Other fault',
];

export interface SwitchReading {
  name?: string;
  description?: string;
  location?: string;
  uptimeSeconds?: number;
  model?: string;
  serial?: string;
  firmware?: string;
  ports: { index: string; name: string; up: boolean; mbps?: number }[];
  poe: {
    port: string;
    enabled: boolean;
    detection: number;
  }[];
  poeMain?: { watts?: number; usedWatts?: number; on?: boolean };
}

const text = (v?: VarBind) => (v && v.kind === 'str' ? v.text!.replace(/[^\x20-\x7e]/g, '').trim() : undefined);
const num = (v?: VarBind) => (v && v.num !== undefined ? v.num : undefined);

/** The first non-empty string in a column of rows, for a chassis value that sits on the first row that has one. */
const firstText = (rows: VarBind[]) => rows.map(text).find((t) => !!t);

/** Table rows by their index, so columns that share an index line up. */
const byIndex = (rows: VarBind[], prefix: string) => new Map(rows.map((r) => [indexOf(r.oid, prefix), r]));

/** Fills out the reading from what the walks returned. Pure, so it can be tested without a device. */
export function readSwitch(raw: {
  sys: VarBind[];
  ifType: VarBind[];
  ifDescr: VarBind[];
  ifName: VarBind[];
  ifAlias: VarBind[];
  ifOper: VarBind[];
  ifSpeed: VarBind[];
  entModel: VarBind[];
  entSerial: VarBind[];
  entSoftware: VarBind[];
  pethAdmin: VarBind[];
  pethDetection: VarBind[];
  pethMainPower: VarBind[];
  pethMainOper: VarBind[];
  pethMainUsed: VarBind[];
}): SwitchReading {
  const sys = new Map(raw.sys.map((v) => [v.oid, v]));
  const types = byIndex(raw.ifType, OID.ifType);
  const descr = byIndex(raw.ifDescr, OID.ifDescr);
  const names = byIndex(raw.ifName, OID.ifName);
  const alias = byIndex(raw.ifAlias, OID.ifAlias);
  const speed = byIndex(raw.ifSpeed, OID.ifHighSpeed);
  const ports: SwitchReading['ports'] = [];
  for (const row of raw.ifOper) {
    const index = indexOf(row.oid, OID.ifOperStatus);
    const type = num(types.get(index));
    if (type !== undefined && !PORT_TYPES.has(type)) continue;
    const label = text(alias.get(index));
    ports.push({
      index,
      name: (label ? `${text(names.get(index)) ?? text(descr.get(index)) ?? index} (${label})` : (text(names.get(index)) ?? text(descr.get(index)) ?? index)),
      up: num(row) === 1,
      mbps: num(speed.get(index)),
    });
  }
  const detection = byIndex(raw.pethDetection, OID.pethDetection);
  const poe: SwitchReading['poe'] = raw.pethAdmin.map((row) => {
    const port = indexOf(row.oid, OID.pethAdmin);
    return { port, enabled: num(row) === 1, detection: num(detection.get(port)) ?? 0 };
  });
  const ticks = num(sys.get(OID.sysUpTime));
  return {
    name: text(sys.get(OID.sysName)),
    description: text(sys.get(OID.sysDescr)),
    location: text(sys.get(OID.sysLocation)),
    uptimeSeconds: ticks === undefined ? undefined : Math.floor(ticks / 100),
    model: firstText(raw.entModel),
    serial: firstText(raw.entSerial),
    firmware: firstText(raw.entSoftware),
    ports,
    poe,
    poeMain: raw.pethMainPower.length
      ? {
          watts: num(raw.pethMainPower[0]),
          usedWatts: num(raw.pethMainUsed[0]),
          on: num(raw.pethMainOper[0]) === 1,
        }
      : undefined,
  };
}

const uptime = (s: number) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`;
};

export function switchDetails(r: SwitchReading): DeviceDetailSection[] {
  const sections: DeviceDetailSection[] = [];
  const identity: DeviceDetailSection['rows'] = [];
  if (r.model) identity.push({ label: 'Model', value: r.model });
  if (r.serial) identity.push({ label: 'Serial number', value: r.serial });
  if (identity.length) sections.push({ title: 'Identity', rows: identity });

  const system: DeviceDetailSection['rows'] = [];
  const add = (label: string, value: string | undefined, status?: DetailStatus) => {
    if (value) system.push({ label, value: value.slice(0, 200), ...(status ? { status } : {}) });
  };
  add('Name', r.name);
  add('Location', r.location);
  add('Uptime', r.uptimeSeconds === undefined ? undefined : uptime(r.uptimeSeconds));
  add('Description', r.description);
  if (r.ports.length) {
    const up = r.ports.filter((p) => p.up).length;
    add('Ports up', `${up} of ${r.ports.length}`);
  }
  if (system.length) sections.push({ title: 'System', rows: system });

  if (r.ports.length)
    sections.push({
      title: 'Ports',
      rows: [],
      table: {
        columns: ['Port', 'Link', 'Speed'],
        rows: r.ports.slice(0, 128).map((p) => ({
          cells: [p.name.slice(0, 120), p.up ? 'Up' : 'Down', p.mbps ? `${p.mbps} Mbps` : ''],
          ...(p.up ? { status: 'ok' as const } : {}),
        })),
      },
    });

  if (r.poe.length || r.poeMain) {
    const rows: DeviceDetailSection['rows'] = [];
    if (r.poeMain?.watts !== undefined) rows.push({ label: 'PoE budget', value: `${r.poeMain.watts} W` });
    if (r.poeMain?.usedWatts !== undefined)
      rows.push({ label: 'PoE in use', value: `${r.poeMain.usedWatts} W` });
    if (r.poeMain?.on !== undefined)
      rows.push({
        label: 'PoE supply',
        value: r.poeMain.on ? 'On' : 'Off',
        status: r.poeMain.on ? 'ok' : 'warning',
      });
    sections.push({
      title: 'PoE',
      rows,
      ...(r.poe.length
        ? {
            table: {
              columns: ['PoE port', 'Enabled', 'Status'],
              rows: r.poe.slice(0, 128).map((p) => ({
                cells: [p.port, p.enabled ? 'Yes' : 'No', DETECTION[p.detection] ?? String(p.detection)],
                ...(p.detection === 3
                  ? { status: 'ok' as const }
                  : p.detection === 4 || p.detection === 6
                    ? { status: 'bad' as const }
                    : {}),
              })),
            },
          }
        : {}),
    });
  }
  return sections;
}

export class SnmpSwitchDriver extends BaseDriver {
  private poller: ReturnType<typeof setInterval> | null = null;
  private last: SwitchReading | null = null;
  private polling = false;

  constructor(device: Device, ctx: DriverContext) {
    super(device, ctx);
    this.state.online = false;
  }

  override features(): string[] {
    return ['snmp'];
  }

  private client(community?: string) {
    const host = this.setting<string>('host', '');
    if (!host) this.fail('no host configured');
    if (consoleAddressBlocked(host, this.device.settings))
      this.fail(`${host} is a cloud metadata address, not a device (add "allowLocalAddress": true to allow it)`);
    return new SnmpClient({
      host,
      port: this.setting<number>('port', 161),
      community: community ?? this.setting<string>('community', 'public'),
      timeoutMs: this.setting<number>('timeoutMs', 3000),
    });
  }

  override start() {
    const host = this.setting<string>('host', '');
    if (!host) return;
    if (consoleAddressBlocked(host, this.device.settings)) {
      this.ctx.log('error', `${this.device.name}'s address (${host}) is a cloud metadata address, not a device, and was refused`, {
        device: this.device.name,
        hint: 'Add "allowLocalAddress": true to this device’s settings if this is deliberate',
      });
      return;
    }
    void this.poll();
    this.poller = setInterval(() => void this.poll(), this.setting<number>('pollMs', 30000));
    this.poller.unref?.();
  }

  override close() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  /** A walk that gives nothing when the device has no such table (a switch with no PoE). */
  private async table(c: SnmpClient, oid: string, limit = 256): Promise<VarBind[]> {
    try {
      return await c.walk(oid, limit);
    } catch (e) {
      if (e instanceof Error && /did not respond/.test(e.message)) throw e;
      return [];
    }
  }

  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const c = this.client();
      // The first thing asked is the proof the device is there: a timeout here is "offline".
      const sys = await c.get([OID.sysDescr, OID.sysUpTime, OID.sysName, OID.sysLocation]);
      const t = (oid: string, limit?: number) => this.table(c, oid, limit);
      const [ifType, ifDescr, ifName, ifAlias, ifOper, ifSpeed] = await Promise.all([
        t(OID.ifType),
        t(OID.ifDescr),
        t(OID.ifName),
        t(OID.ifAlias),
        t(OID.ifOperStatus),
        t(OID.ifHighSpeed),
      ]);
      const [entModel, entSerial, entSoftware] = await Promise.all([
        t(OID.entModel, 8),
        t(OID.entSerial, 8),
        t(OID.entSoftwareRev, 8),
      ]);
      const [pethAdmin, pethDetection, pethMainPower, pethMainOper, pethMainUsed] = await Promise.all([
        t(OID.pethAdmin),
        t(OID.pethDetection),
        t(OID.pethMainPower, 4),
        t(OID.pethMainOper, 4),
        t(OID.pethMainUsed, 4),
      ]);
      const reading = readSwitch({
        sys,
        ifType,
        ifDescr,
        ifName,
        ifAlias,
        ifOper,
        ifSpeed,
        entModel,
        entSerial,
        entSoftware,
        pethAdmin,
        pethDetection,
        pethMainPower,
        pethMainOper,
        pethMainUsed,
      });
      this.last = reading;
      const points: Record<string, number | boolean | string> = {};
      for (const p of this.device.points ?? []) {
        const v = await this.pointValue(c, p.address, reading).catch(() => undefined);
        if (v !== undefined) points[p.id] = v;
      }
      this.update((s) => {
        s.online = true;
        s.points = points as never;
        if (reading.firmware) s.firmware = reading.firmware.slice(0, 100);
        s.details = switchDetails(reading);
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

  private async pointValue(
    c: SnmpClient,
    address: ControlPoint['address'],
    r: SwitchReading | null,
  ): Promise<number | boolean | string | undefined> {
    if (typeof address.oid === 'string' && address.oid) {
      const [v] = await c.get([address.oid.trim()]);
      if (!v || v.kind === 'missing') return undefined;
      return v.num ?? v.text;
    }
    const port = String(address.port ?? '');
    const field = String(address.field ?? 'link').toLowerCase();
    if (field === 'poe') return r?.poe.find((p) => p.port === port)?.detection === 3;
    if (field === 'link') return r?.ports.find((p) => p.index === port)?.up;
    return undefined;
  }

  async readPoint(point: Pick<ControlPoint, 'type' | 'address' | 'min' | 'max'>): Promise<PointReading> {
    const v = await this.pointValue(this.client(), point.address, this.last);
    if (v === undefined) this.fail('that value was not found');
    return { value: v };
  }

  async send(command: DeviceCommand): Promise<void> {
    if (command.type !== 'command') this.fail(`does not support "${command.type}"`);
    const m = /^poe_(on|off|cycle)_(\d+)_(\d+)$/.exec(command.name);
    if (!m) this.fail(`does not support "${command.name}"`);
    const write = this.setting<string>('writeCommunity', '');
    if (!write) this.fail('needs a write community to switch PoE (set "writeCommunity")');
    const c = this.client(write);
    const oid = `${OID.pethAdmin}.${m[2]}.${m[3]}`;
    const set = (on: boolean) => c.setInt(oid, on ? 1 : 2, write);
    try {
      if (m[1] === 'on') await set(true);
      else if (m[1] === 'off') await set(false);
      else {
        await set(false);
        await new Promise((r) => setTimeout(r, this.setting<number>('cycleMs', 5000)));
        await set(true);
      }
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => void this.poll(), 1500).unref?.();
  }
}
