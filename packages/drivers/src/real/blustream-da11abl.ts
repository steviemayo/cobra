import type { Device, DeviceCommand, DeviceDetailSection } from '@kestrel/model';
import { askConsole, consoleAddressBlocked, tellConsole, type ConsoleTarget } from './ascii-console';
import { BaseDriver } from './base';
import type { DriverContext } from './types';

// Blustream DA11ABL-WP-V2 Bluetooth wall plate: a two-input (analogue, Bluetooth) audio combiner
// with one analogue output, over its ASCII console (Telnet-style, checked against Blustream's own
// command reference). Modelled as a 2:1 audio switcher (category `audio_matrix`, the `route`
// command from the `video_switching` class, reused here for an audio-only device the same way
// `lib:extron-sis` reuses it for both categories): route port id "in1" is the analogue input,
// "in2" is Bluetooth (by trailing digit, the same convention the declarative format uses).
//
// Settings: host, port (23), pollMs (15000, how often Bluetooth status is checked), timeoutMs (3000).
//
// NOT YET VERIFIED AGAINST REAL HARDWARE: the reference names `BT SOURCE` ("Bluetooth RX Connected
// Source List") but never shows what it prints, so connected/paired-name are read with permissive
// regexes over the raw reply rather than a named field, and the raw text is always kept as its own
// details row too, so a guess that misses still leaves the real answer visible.
const CONNECTED_RE = /\bconnect(?:ed)?\b/i;
const NOT_CONNECTED_RE = /\b(disconnect(?:ed)?|not\s*connected|no\s*device|idle|none)\b/i;
const NAME_RE = /(?:name|device)\s*[:=]?\s*"?([A-Za-z0-9][\w .'-]{0,29})"?/i;
/** Falls back to whatever word sits right before "Connected" (a plausible shape for an unnamed reply). */
const NAME_BEFORE_CONNECTED_RE = /([A-Za-z0-9][\w-]{1,29})\s+connect(?:ed)?\b/i;

export class BlustreamDa11ablDriver extends BaseDriver {
  private poller: ReturnType<typeof setInterval> | null = null;

  constructor(device: Device, ctx: DriverContext) {
    super(device, ctx);
    this.state.online = false;
  }

  override start() {
    const host = this.setting<string>('host', '');
    if (!host) return;
    if (consoleAddressBlocked(host, this.device.settings)) {
      this.ctx.log(
        'error',
        `${this.device.name}'s address (${host}) is a cloud metadata address, not a device, and was refused`,
        { device: this.device.name, hint: 'Add "allowLocalAddress": true to this device’s settings if this is deliberate' },
      );
      return;
    }
    void this.poll();
    const every = this.setting<number>('pollMs', 15000);
    this.poller = setInterval(() => void this.poll(), every);
    this.poller.unref?.();
  }

  override close() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  private connectTarget(): ConsoleTarget | Error {
    const host = this.setting<string>('host', '');
    if (!host) return new Error(`${this.device.name}: no host configured`);
    if (consoleAddressBlocked(host, this.device.settings))
      return new Error(`${host} is a cloud metadata address, not a device (add "allowLocalAddress": true to allow it)`);
    return { host, port: this.setting<number>('port', 23) };
  }

  /** Sends one line and collects whatever text comes back until the console goes quiet. */
  private ask(text: string): Promise<string> {
    const target = this.connectTarget();
    if (target instanceof Error) return Promise.reject(target);
    return askConsole(target, text, this.setting<number>('timeoutMs', 3000), this.device.name);
  }

  /**
   * Sends one line and does not wait for a reply: the reference shows no acknowledgement text for
   * any control command, so waiting for one would just make every command time out.
   */
  private tell(text: string): Promise<void> {
    const target = this.connectTarget();
    if (target instanceof Error) return Promise.reject(target);
    return tellConsole(target, text, this.setting<number>('timeoutMs', 3000), this.device.name);
  }

  private async poll() {
    try {
      const reply = await this.ask('BT SOURCE');
      this.applyBluetooth(reply);
      this.update((s) => {
        s.online = true;
      });
    } catch {
      this.update((s) => {
        s.online = false;
      });
    }
  }

  private applyBluetooth(raw: string) {
    const text = raw.replace(/[^\x20-\x7e\r\n]/g, '').trim();
    const connected = NOT_CONNECTED_RE.test(text) ? false : CONNECTED_RE.test(text) ? true : undefined;
    // Only trusted when connected: "Not Connected" would otherwise read "Not" as a device name.
    const name = NAME_RE.exec(text)?.[1]?.trim() ?? (connected ? NAME_BEFORE_CONNECTED_RE.exec(text)?.[1]?.trim() : undefined);
    const rows: DeviceDetailSection['rows'] = [];
    if (connected !== undefined)
      rows.push({
        label: 'Bluetooth',
        value: connected ? 'Connected' : 'Not connected',
        ...(connected ? { status: 'ok' as const } : {}),
      });
    if (name) rows.push({ label: 'Paired device', value: name });
    if (text) rows.push({ label: 'Bluetooth (raw reply)', value: text.slice(0, 200) });
    if (rows.length)
      this.update((s) => {
        s.details = [{ title: 'Bluetooth', rows }];
      });
  }

  async send(command: DeviceCommand): Promise<void> {
    let text: string;
    switch (command.type) {
      case 'route': {
        const n = Number(/\d+/.exec(command.inputPortId)?.[0] ?? '1');
        text = `IN SOURCE ${n === 2 ? 2 : 1}`;
        break;
      }
      case 'mute':
        text = `OUT MUTE ${command.muted ? 'ON' : 'OFF'}`;
        break;
      case 'volume': {
        // "OUT GAIN" runs 0 (loudest, +20dBu) to 15 (quietest, -28dBV): the reverse of the room's
        // 0-100, so 100 on the panel asks for 0 here.
        const native = Math.max(0, Math.min(15, Math.round(((100 - command.level) / 100) * 15)));
        text = `OUT GAIN ${native}`;
        break;
      }
      default:
        this.fail(`does not support "${command.type}"`);
    }
    try {
      await this.tell(text);
    } catch (e) {
      this.update((s) => {
        s.online = false;
      });
      throw e;
    }
    this.update((s) => {
      s.online = true;
      if (command.type === 'route') s.routes[command.outputPortId] = command.inputPortId;
      if (command.type === 'mute') s.muted = command.muted;
      if (command.type === 'volume') s.volume = command.level;
    });
  }
}
