import type {
  ControlPoint,
  DetailStatus,
  Device,
  DeviceCommand,
  DeviceDetailSection,
  PointReading,
} from '@kestrel/model';
import { askConsole, consoleAddressBlocked, tellConsole, type ConsoleTarget } from './ascii-console';
import { BaseDriver } from './base';
import type { DriverContext } from './types';

// Blustream PWR2IEC / PWR4IEC / PWR8IEC IEC power controllers, over the ASCII console (Telnet, port
// 23). Verified against a real PWR4IEC (firmware V1.1.0): `STATUS` prints the unit, each outlet's
// state and whether something is connected to it, and the voltage, current, power and energy of every
// outlet; `ALLOUT ON|OFF` and `OUTLET n ON|OFF` switch. Control commands print nothing useful, so a
// command counts as done once sent and the next status read confirms it.
//
// "Power" switches every outlet; `command` names `outlet<n>_on` and `outlet<n>_off` switch one, the
// same names the bundled `lib:blustream-pwr8iec` driver uses.
//
// Control points: one outlet's reading, as a generic point with the address { outlet: "3", field }.
// `field` is state (on or off), load (something is connected), amps, watts, kwh or volts. That is how
// one controller shared by several rooms gives each room its own outlets to watch.
//
// Settings: host, port (23), pollMs (15000), timeoutMs (3000).
//
// The PWR2IEC and PWR8IEC are expected to print the same layout with fewer or more outlets; only the
// PWR4IEC has been seen.

const ELECTRIC_RE = /^\s*(\d+|SYS)\s+([\d.]+)V\s+([\d.]+)A\s+([\d.]+)W\s+([\d.]+)kWh\s+([\d.]+)\s+([\d.]+)Hz/gim;
const OUTLET_RE = /^\s*(\d+)\s+(ON|OFF)\s+(\w+)\s+\d+s\b/gim;
const MAC_RE = /\b([0-9A-F]{2}(?::[0-9A-F]{2}){5})\b/i;

export interface PwrReading {
  model?: string;
  firmware?: string;
  mac?: string;
  ip?: string;
  system?: string;
  outlets: { n: number; on: boolean; mode: string }[];
  electric: Record<string, { volts: string; amps: string; watts: string; kwh: string }>;
}

/** Reads the text `STATUS` prints. Fields it cannot find are left out. */
export function parsePwrStatus(text: string): PwrReading {
  const t = text.replace(/[^\x20-\x7e\r\n]/g, '');
  const model = /^\s*(PWR\d+\w*)\s/m.exec(t)?.[1];
  const firmware = /FW Version:\s*(\S+)/i.exec(t)?.[1];
  // The first address in the TCP/IP1 block is the unit's own, written with zero padding.
  const ipRaw = /^\s*(?:ON|OFF)\s+(\d{3}\.\d{3}\.\d{3}\.\d{3})/m.exec(t)?.[1];
  const ip = ipRaw?.split('.').map((p) => String(Number(p))).join('.');
  const system = /^\s*SYS\s+(ON|OFF)\s+(\w+)\s*$/im.exec(t)?.[2];
  const outlets = [...t.matchAll(OUTLET_RE)].map((m) => ({
    n: Number(m[1]),
    on: m[2]!.toUpperCase() === 'ON',
    mode: m[3]!,
  }));
  const electric: PwrReading['electric'] = {};
  for (const m of t.matchAll(ELECTRIC_RE))
    electric[m[1]!.toUpperCase()] = { volts: m[2]!, amps: m[3]!, watts: m[4]!, kwh: m[5]! };
  return { model, firmware, mac: MAC_RE.exec(t)?.[1]?.toUpperCase(), ip, system, outlets, electric };
}

/** What one outlet point reads from a status, or undefined when the outlet or field is not there. */
export function pwrPointValue(
  address: ControlPoint['address'],
  r: PwrReading,
): number | boolean | undefined {
  const n = Number(address.outlet);
  const field = String(address.field ?? 'state').toLowerCase();
  const o = r.outlets.find((x) => x.n === n);
  if (field === 'state') return o?.on;
  if (field === 'load') return o ? o.mode.toLowerCase() === 'connected' : undefined;
  const e = r.electric[String(n)];
  const v = e && { amps: e.amps, watts: e.watts, kwh: e.kwh, volts: e.volts }[field as 'amps'];
  return v === undefined ? undefined : Number(v);
}

export class BlustreamPwrDriver extends BaseDriver {
  private poller: ReturnType<typeof setInterval> | null = null;

  constructor(device: Device, ctx: DriverContext) {
    super(device, ctx);
    this.state.online = false;
  }

  override features(): string[] {
    return ['on_off'];
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
    this.poller = setInterval(() => void this.poll(), this.setting<number>('pollMs', 15000));
    this.poller.unref?.();
  }

  override close() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  private target(): ConsoleTarget {
    const host = this.setting<string>('host', '');
    if (!host) this.fail('no host configured');
    if (consoleAddressBlocked(host, this.device.settings))
      this.fail(`${host} is a cloud metadata address, not a device (add "allowLocalAddress": true to allow it)`);
    return { host, port: this.setting<number>('port', 23) };
  }

  private async poll() {
    try {
      const reading = parsePwrStatus(
        await askConsole(this.target(), 'STATUS', this.setting<number>('timeoutMs', 3000), this.device.name),
      );
      // A reply with no outlets is not a PWR status (a different prompt, a login), so not "online".
      if (reading.outlets.length === 0) throw new Error('unexpected reply');
      this.apply(reading);
    } catch (e) {
      this.ctx.log('warn', `${this.device.name}: ${e instanceof Error ? e.message : String(e)}`);
      this.update((s) => {
        s.online = false;
      });
    }
  }

  private apply(r: PwrReading) {
    const unit: DeviceDetailSection['rows'] = [];
    const add = (label: string, value: string | undefined, status?: DetailStatus) => {
      if (value) unit.push({ label, value, ...(status ? { status } : {}) });
    };
    add('Model', r.model);
    add('Firmware', r.firmware);
    add('MAC address', r.mac);
    add('Address', r.ip);
    add('System', r.system, r.system ? (/^normal$/i.test(r.system) ? 'ok' : 'bad') : undefined);
    const sys = r.electric.SYS;
    if (sys) {
      add('Voltage', `${sys.volts} V`);
      add('Total load', `${sys.watts} W (${sys.amps} A)`);
    }
    const sections: DeviceDetailSection[] = [{ title: 'Unit', rows: unit }];
    sections.push({
      title: 'Outlets',
      rows: [],
      table: {
        columns: ['Outlet', 'State', 'Load', 'Current', 'Power', 'Energy'],
        rows: r.outlets.map((o) => {
          const e = r.electric[String(o.n)];
          return {
            cells: [
              String(o.n),
              o.on ? 'On' : 'Off',
              o.mode === 'Connected' ? 'Connected' : o.mode,
              e ? `${e.amps} A` : '',
              e ? `${e.watts} W` : '',
              e ? `${e.kwh} kWh` : '',
            ],
            ...(o.on ? { status: 'ok' as const } : {}),
          };
        }),
      },
    });
    const points: Record<string, number | boolean> = {};
    for (const p of this.device.points ?? []) {
      const v = pwrPointValue(p.address, r);
      if (v !== undefined) points[p.id] = v;
    }
    this.update((s) => {
      s.online = true;
      s.points = points;
      s.power = r.outlets.some((o) => o.on) ? 'on' : 'off';
      if (r.firmware) s.firmware = r.firmware.slice(0, 100);
      s.details = sections;
    });
  }

  /** Reads one outlet point now, to check it before it is saved. */
  async readPoint(point: Pick<ControlPoint, 'type' | 'address' | 'min' | 'max'>): Promise<PointReading> {
    const r = parsePwrStatus(
      await askConsole(this.target(), 'STATUS', this.setting<number>('timeoutMs', 3000), this.device.name),
    );
    const v = pwrPointValue(point.address, r);
    if (v === undefined) this.fail('that outlet or reading was not found');
    return { value: v };
  }

  async send(command: DeviceCommand): Promise<void> {
    let text: string;
    if (command.type === 'power') text = `ALLOUT ${command.on ? 'ON' : 'OFF'}`;
    else if (command.type === 'command') {
      const m = /^outlet(\d{1,2})_(on|off)$/.exec(command.name);
      if (!m) this.fail(`does not support "${command.name}"`);
      text = `OUTLET ${Number(m[1])} ${m[2]!.toUpperCase()}`;
    } else this.fail(`does not support "${command.type}"`);
    try {
      await tellConsole(this.target(), text, this.setting<number>('timeoutMs', 3000), this.device.name);
    } catch (e) {
      this.update((s) => {
        s.online = false;
      });
      throw e;
    }
    // Give the unit a moment to switch, then read it back so the state shows what really happened.
    setTimeout(() => void this.poll(), 800).unref?.();
  }
}
