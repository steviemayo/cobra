import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import type { Device, DeviceCommand, PowerState } from '@kestrel/model';
import { BaseDriver } from './base';
import type { DriverContext } from './types';

// PJLink class 1 (projectors and many displays). Settings: host, port (4352), password,
// inputs (portId -> PJLink input code, e.g. { in: "31" } for HDMI 1), warmupTimeoutMs, pollMs.
const POWER: Record<string, PowerState> = { '0': 'off', '1': 'on', '2': 'cooling', '3': 'warming' };

const ERRORS: Record<string, string> = {
  ERR1: 'command not supported',
  ERR2: 'value out of range',
  ERR3: 'unavailable right now',
  ERR4: 'projector failure',
  ERRA: 'wrong password',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PjlinkDriver extends BaseDriver {
  private poller: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(device: Device, ctx: DriverContext) {
    super(device, ctx);
    this.state.power = 'off';
    this.state.selectedInput = null;
    this.state.online = false;
  }

  private get host() {
    return this.setting<string>('host', '');
  }
  private get port() {
    return this.setting<number>('port', 4352);
  }

  /** One short-lived PJLink session: greeting, one command, one reply. */
  private exchange(body: string): Promise<string> {
    if (!this.host) return Promise.reject(new Error(`${this.device.name}: no host configured`));
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      let buffer = '';
      let greeted = false;
      let done = false;
      const finish = (err: Error | null, value?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(value ?? '');
      };
      const timer = setTimeout(() => finish(new Error(`${this.device.name} did not respond`)), 4000);
      socket.on('error', (e) => finish(new Error(`${this.device.name}: ${e.message}`)));
      socket.on('close', () => finish(new Error(`${this.device.name} closed the connection`)));
      socket.on('data', (chunk) => {
        buffer += chunk.toString('latin1');
        let end: number;
        while ((end = buffer.indexOf('\r')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!greeted) {
            greeted = true;
            const [, auth, salt] = line.split(' ');
            let prefix = '';
            if (auth === '1') {
              const password = this.setting<string>('password', '');
              prefix = createHash('md5').update(`${salt ?? ''}${password}`).digest('hex');
            }
            socket.write(`${prefix}%1${body}\r`);
          } else {
            finish(null, line);
          }
        }
      });
    });
  }

  /** Runs a command and returns the value after '=', throwing PJLink errors in plain language. */
  private async command(body: string): Promise<string> {
    const reply = await this.exchange(body);
    // Any reply, even an error, means the device is reachable.
    this.update((s) => {
      s.online = true;
    });
    // A rejected password is answered with "PJLINK ERRA" rather than a normal reply.
    if (reply.startsWith('PJLINK ERRA')) this.fail(ERRORS.ERRA!);
    const value = reply.split('=')[1] ?? '';
    if (value in ERRORS) this.fail(ERRORS[value]!);
    if (/^ERR/.test(value)) this.fail(`error ${value}`);
    return value;
  }

  private async refresh() {
    try {
      const power = await this.command('POWR ?');
      const input = POWER[power] === 'on' ? await this.command('INPT ?') : null;
      this.update((s) => {
        s.online = true;
        s.power = POWER[power] ?? s.power;
        if (input !== null) {
          const map = this.setting<Record<string, string>>('inputs', {});
          s.selectedInput = Object.entries(map).find(([, code]) => code === input)?.[0] ?? s.selectedInput ?? null;
        } else if (POWER[power] === 'off') s.selectedInput = null;
      });
    } catch {
      this.update((s) => {
        s.online = false;
      });
    }
  }

  override start() {
    void this.refresh();
    const every = this.setting<number>('pollMs', 10_000);
    this.poller = setInterval(() => void this.refresh(), every);
  }

  override close() {
    this.closed = true;
    if (this.poller) clearInterval(this.poller);
  }

  private async waitForPower(target: PowerState, timeoutMs: number) {
    const started = Date.now();
    while (!this.closed) {
      await this.refresh();
      if (this.state.power === target) return;
      if (Date.now() - started > timeoutMs) this.fail(`did not turn ${target === 'on' ? 'on' : 'off'} in time`);
      await sleep(1000);
    }
  }

  async send(command: DeviceCommand): Promise<void> {
    switch (command.type) {
      case 'power': {
        if (command.on) {
          await this.command('POWR 1');
          this.update((s) => {
            s.online = true;
            s.power = 'warming';
          });
          await this.waitForPower('on', this.setting<number>('warmupTimeoutMs', 90_000));
        } else {
          await this.command('POWR 0');
          this.update((s) => {
            s.online = true;
            s.power = 'cooling';
            s.selectedInput = null;
          });
          // Room Off shouldn't wait for the lamp to cool; keep tracking in the background.
          void this.waitForPower('off', 120_000).catch(() => undefined);
        }
        return;
      }
      case 'select_input': {
        const map = this.setting<Record<string, string>>('inputs', {});
        const ports = this.device.ports.filter((p) => p.direction === 'in');
        const code = map[command.portId] ?? String(31 + Math.max(0, ports.findIndex((p) => p.id === command.portId)));
        await this.command(`INPT ${code}`);
        this.update((s) => {
          s.selectedInput = command.portId;
        });
        return;
      }
      default:
        this.fail(`doesn't support ${command.type}`);
    }
  }
}
