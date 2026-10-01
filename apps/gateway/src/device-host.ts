import { createHash } from 'node:crypto';
import { createDriver, type DeviceDriver } from '@kestrel/drivers/real';
import {
  Device,
  type DeviceCommand,
  DeviceDetails,
  type DeviceReport,
  type MonitoredDevice,
  type SignedDeviceSet,
} from '@kestrel/model';
import type { Logger } from './log';
import { deviceFeedback } from './device-feedback';
import { Prober } from './probe';

// v2 (docs/pivot-monitoring.md): the devices a gateway polls on their own, whatever room they are in.
// There is no room program here: each device gets its driver, its connection, and a report.

/** How long before device details are sent again even though they have not changed. */
const DETAILS_REFRESH_MS = 5 * 60_000;

/**
 * A device that has just been opened is not reported until it has answered once, or this long has
 * passed: a driver's state starts as "online", and saying so before it has tried would be a guess.
 */
export const SETTLE_MS = 5_000;

interface Running {
  startedAt: number;
  /** The driver has reported a state at least once. */
  heard: boolean;
  off: () => void;
  /** What it was built from, so a changed address or driver rebuilds it and nothing else does. */
  fingerprint: string;
  device: Device;
  driver: DeviceDriver;
}

const fingerprintOf = (d: MonitoredDevice) =>
  createHash('sha256')
    .update(JSON.stringify([d.name, d.category, d.control, d.settings]))
    .digest('hex');

export class DeviceHost {
  private readonly running = new Map<string, Running>();
  private readonly sentDetails = new Map<string, { json: string; at: number }>();
  private version: string | null = null;

  constructor(
    private readonly log: Logger,
    private readonly prober: Prober = new Prober(),
  ) {}

  /** Starts the steady pinging of the devices (kept apart so tests don't ping anything). */
  start() {
    this.prober.start();
  }

  /** The version of the device set now running, or null when none has been applied. */
  get setVersion() {
    return this.version;
  }

  get size() {
    return this.running.size;
  }

  /**
   * Makes the running devices match a verified set: new ones are opened, changed ones rebuilt,
   * removed ones closed. A device whose driver cannot be built is skipped and logged, never fatal.
   */
  apply(signed: SignedDeviceSet | null) {
    const wanted = new Map((signed?.payload.devices ?? []).map((d) => [d.id, d]));
    for (const [id, run] of this.running)
      if (!wanted.has(id)) {
        run.off();
        run.driver.close();
        this.running.delete(id);
        this.sentDetails.delete(id);
        this.prober.untrack(id);
        this.log('info', 'Stopped polling a device', { device: run.device.name, deviceId: id });
      }
    for (const [id, d] of wanted) {
      const fingerprint = fingerprintOf(d);
      const current = this.running.get(id);
      if (current?.fingerprint === fingerprint) continue;
      current?.off();
      current?.driver.close();
      this.running.delete(id);
      const parsed = Device.safeParse({
        id: d.id,
        name: d.name,
        category: d.category,
        ports: [],
        control: d.control,
        settings: d.settings,
      });
      if (!parsed.success) {
        this.log('warn', 'A device could not be read and was skipped', { deviceId: id });
        continue;
      }
      const device = parsed.data;
      const driver = createDriver(device, {
        log: (level, message, extra) => this.log(level, message, { device: device.name, ...extra }),
      });
      if (!driver) {
        this.log('warn', 'No driver for a device; it is not being polled', {
          device: device.name,
          deviceId: id,
        });
        continue;
      }
      const run: Running = {
        startedAt: Date.now(),
        heard: false,
        off: () => undefined,
        fingerprint,
        device,
        driver,
      };
      run.off = driver.onChange(() => {
        run.heard = true;
      });
      driver.start();
      this.running.set(id, run);
      // Ping the device's own address, unless its settings say not to.
      const host = typeof device.settings.host === 'string' ? device.settings.host : undefined;
      this.prober.track(
        id,
        device.settings.probe === false ? undefined : host,
        device.settings.allowLocalAddress === true,
      );
      this.log('info', 'Polling a device', { device: device.name, deviceId: id });
    }
    this.version = signed?.payload.version ?? null;
  }

  /** What each polled device says now, in the shape the heartbeat carries. */
  reports(now = Date.now()): DeviceReport[] {
    return [...this.running.values()]
      .filter((r) => r.heard || now - r.startedAt >= SETTLE_MS)
      .map(({ device, driver }) => {
        const state = driver.getState();
        const feedback = deviceFeedback(state, device.ports);
        const control = device.control;
        const driverName =
          control?.kind === 'driver'
            ? control.driverId
            : control?.kind === 'generic'
              ? control.protocol
              : undefined;
        const details = this.detailsFor(device.id, state.details, now);
        const latency = this.prober.take(device.id, state.online ?? true);
        return {
          deviceId: device.id,
          name: device.name,
          online: state.online ?? true,
          ...(driverName && { driver: driverName }),
          ...(state.firmware && { firmware: state.firmware }),
          ...(latency && { latency }),
          ...(Object.keys(feedback).length > 0 && { feedback }),
          ...(details && { details }),
        };
      });
  }

  /** Details go up when they change and now and then as a refresh, so absent means "same as last time". */
  private detailsFor(deviceId: string, details: unknown, now: number) {
    if (!details) return undefined;
    const parsed = DeviceDetails.safeParse(details);
    if (!parsed.success) return undefined;
    const json = JSON.stringify(parsed.data);
    const sent = this.sentDetails.get(deviceId);
    if (sent && sent.json === json && now - sent.at < DETAILS_REFRESH_MS) return undefined;
    this.sentDetails.set(deviceId, { json, at: now });
    return parsed.data;
  }

  /**
   * Sends one command to a polled device (a setting the cloud wants put back). A device that is not
   * running, or that refuses, is reported as false and left for the cloud to try again later.
   */
  async execute(deviceId: string, command: DeviceCommand): Promise<boolean> {
    const run = this.running.get(deviceId);
    if (!run) return false;
    try {
      await run.driver.send(command);
      this.log('info', 'Put a setting back', { device: run.device.name, command: command.type });
      return true;
    } catch (e) {
      this.log('warn', 'A device refused a setting', { device: run.device.name, error: String(e) });
      return false;
    }
  }

  shutdown() {
    this.prober.stop();
    for (const run of this.running.values()) {
      run.off();
      run.driver.close();
    }
    this.running.clear();
  }
}
