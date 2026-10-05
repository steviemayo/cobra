import { createHash } from 'node:crypto';
import { createDriver, type DeviceDriver } from '@kestrel/drivers/real';
import {
  ADDRESS_TRACKING_KEY,
  Device,
  DeviceCategory,
  type DeviceCommand,
  DeviceDetails,
  type BrowsedPoints,
  type DeviceReport,
  type MonitoredDevice,
  type SignedDeviceSet,
  type WatchedPoint,
  checkWatch,
} from '@kestrel/model';
import { AddressWatch, swapAddress, trackingOf, type AddressDeps } from './address-tracker';
import type { Logger } from './log';
import { deviceFeedback } from './device-feedback';
import { FastFail } from './fastfail';
import { Prober } from './probe';

// v2 (docs/pivot-monitoring.md): the devices a gateway polls on their own, whatever room they are in.
// There is no room program here: each device gets its driver, its connection, and a report.

/** How long before device details are sent again even though they have not changed. */
const DETAILS_REFRESH_MS = 5 * 60_000;
/** The largest picture sent to the cloud, so a heartbeat stays well under its body limit. */
const MAX_SNAPSHOT_BYTES = 1_500_000;

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
    .update(JSON.stringify([d.name, d.category, d.control, d.settings, d.points]))
    .digest('hex');

/** How often tracked devices are looked after (quiet ones searched for, healthy ones checked). */
const ADDRESS_TICK_MS = 5_000;

const hostOf = (settings: Record<string, unknown>): string | undefined => {
  for (const k of ['host', 'address', 'ip'])
    if (typeof settings[k] === 'string' && settings[k]) return settings[k] as string;
  return undefined;
};

/** The control port to look for a device on: its own setting, or the standard one for PJLink. */
const portOf = (d: MonitoredDevice): number | undefined => {
  const own = Number(d.settings.port);
  if (Number.isInteger(own) && own > 0) return own;
  return isPjlink(d) ? 4352 : undefined;
};
const isPjlink = (d: MonitoredDevice) =>
  (d.control?.kind === 'generic' && d.control.protocol === 'pjlink') ||
  (d.control?.kind === 'driver' && d.control.driverId === 'pjlink');

export class DeviceHost {
  private readonly running = new Map<string, Running>();
  private readonly sentDetails = new Map<string, { json: string; at: number }>();
  private version: string | null = null;
  private lastSet: SignedDeviceSet | null = null;
  private addressTimer: ReturnType<typeof setInterval> | null = null;
  /** Looks after devices whose address can change: finds them again when they move. */
  private readonly address: AddressWatch;

  constructor(
    private readonly log: Logger,
    private readonly prober: Prober = new Prober(),
    private readonly fastFail: FastFail = new FastFail({
      driverOnline: (id) => this.running.get(id)?.driver.getState().online,
      onChange: () => this.onUrgent?.(),
    }),
    addressDeps?: AddressDeps,
  ) {
    this.address = new AddressWatch(log, addressDeps, () => this.reapply());
  }

  /** Called when a device is confirmed down or comes back, so the gateway can tell the cloud at once. */
  onUrgent: (() => void) | null = null;

  /** Starts the steady pinging of the devices (kept apart so tests don't ping anything). */
  start() {
    this.prober.start();
    this.fastFail.start();
    if (!this.addressTimer) {
      this.addressTimer = setInterval(() => void this.tickAddresses(), ADDRESS_TICK_MS);
      this.addressTimer.unref?.();
    }
  }

  /** Whether a device looks reachable now: the fast check's word if it has one, else its driver's. */
  private looksOnline(id: string): boolean {
    const verdict = this.fastFail.verdict(id);
    return verdict ? verdict.online : (this.running.get(id)?.driver.getState().online ?? true);
  }

  /** Every address a running device is using, so one device is never taken for another. */
  private claimedAddresses(): Set<string> {
    const out = new Set<string>();
    for (const r of this.running.values()) {
      const h = hostOf(r.device.settings);
      if (h) out.add(h);
    }
    return out;
  }

  /** One pass over the tracked devices (also called by tests). */
  tickAddresses(): Promise<void> {
    return this.address.tick((id) => this.looksOnline(id), this.claimedAddresses());
  }

  /** A device was found at a new address: run it there now, until the cloud's set says so too. */
  private reapply() {
    if (this.lastSet) this.apply(this.lastSet);
    this.onUrgent?.();
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
    this.lastSet = signed;
    const wanted = new Map((signed?.payload.devices ?? []).map((d) => [d.id, d]));
    for (const [id, run] of this.running)
      if (!wanted.has(id)) {
        run.off();
        run.driver.close();
        this.running.delete(id);
        this.sentDetails.delete(id);
        this.prober.untrack(id);
        this.fastFail.untrack(id);
        this.address.untrack(id);
        this.log('info', 'Stopped polling a device', { device: run.device.name, deviceId: id });
      }
    for (const [id, cloud] of wanted) {
      // A tracked device that has moved runs at its new address until the cloud's set carries it.
      const tracking = trackingOf(cloud.settings);
      const cloudHost = hostOf(cloud.settings);
      this.address.track(
        id,
        tracking && cloudHost
          ? { host: cloudHost, port: portOf(cloud), tracking, pjlink: isPjlink(cloud) }
          : undefined,
      );
      const moved = this.address.override(id);
      // The tracking details are for this gateway, not the driver, and changing them rebuilds nothing.
      const { [ADDRESS_TRACKING_KEY]: _tracking, ...rest } = cloud.settings;
      void _tracking;
      const d: MonitoredDevice = {
        ...cloud,
        settings: moved ? swapAddress(rest, moved.from, moved.to) : rest,
      };
      const fingerprint = fingerprintOf(d);
      const current = this.running.get(id);
      if (current?.fingerprint === fingerprint) continue;
      current?.off();
      current?.driver.close();
      this.running.delete(id);
      // Estate-only categories (a network switch, a UPS, an access point) are not room device
      // categories. The driver does not read the category, so they run as an infrastructure device.
      const category = DeviceCategory.safeParse(d.category).success ? d.category : 'control_processor';
      const parsed = Device.safeParse({
        id: d.id,
        name: d.name,
        category,
        ports: [],
        control: d.control,
        settings: d.settings,
        points: d.points,
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
      // Confirm a failure here, in seconds, unless its settings say not to.
      const port = Number(device.settings.port);
      this.fastFail.track(
        id,
        device.settings.fastFail === false ? undefined : host,
        Number.isFinite(port) ? port : undefined,
        {
          everyMs: Number(device.settings.checkEveryMs) || undefined,
          failsToConfirm: Number(device.settings.failsToConfirm) || undefined,
        },
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
        const verdict = this.fastFail.verdict(device.id);
        // Something else answers at a tracked device's address, so it is not there, whatever its driver says.
        const wrongDevice = this.address.identityChanged(device.id);
        const online = wrongDevice ? false : (verdict?.online ?? state.online ?? true);
        const latency = this.prober.take(device.id, online);
        const address = this.address.report(device.id);
        const { readings, watched } = this.pointsOf(device, state.points);
        return {
          deviceId: device.id,
          name: device.name,
          online,
          ...(verdict?.confirmed && { confirmed: true, offlineForMs: verdict.offlineForMs }),
          ...(wrongDevice && !verdict?.confirmed && { confirmed: true, offlineForMs: 0 }),
          ...(address && { address }),
          ...(driverName && { driver: driverName }),
          ...(state.firmware && { firmware: state.firmware }),
          ...(latency && { latency }),
          ...(readings && { points: readings }),
          ...(watched && { watched }),
          ...(Object.keys(feedback).length > 0 && { feedback }),
          ...(details && { details }),
        };
      });
  }

  /**
   * What each of a device's control points reads now, and for the ones that are watched whether the
   * reading is in bounds. A point with no reading yet is left out of both: Kestrel says nothing
   * rather than guess.
   */
  private pointsOf(device: Device, state: Record<string, number | boolean | string>) {
    const points = device.points ?? [];
    if (points.length === 0) return {};
    const readings: Record<string, number | boolean | string> = {};
    const watched: WatchedPoint[] = [];
    for (const p of points) {
      const value = state[p.id];
      if (value === undefined) continue;
      readings[p.id] = value;
      if (!p.watch) continue;
      const result = checkWatch(p.name, p.watch, value);
      watched.push({
        pointId: p.id,
        name: p.name,
        ok: result.ok,
        ...(result.ok ? {} : { message: result.message.slice(0, 300) }),
        severity: p.watch.severity,
      });
    }
    return {
      ...(Object.keys(readings).length > 0 && { readings }),
      ...(watched.length > 0 && { watched }),
    };
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

  /**
   * Lists what one polled device could be watched for, for the portal's pick-list. It has to be
   * running and answering: a device that is down, or whose driver cannot list itself, says so.
   */
  async browse(
    deviceId: string,
  ): Promise<{ ok: true; found: BrowsedPoints } | { ok: false; error: string }> {
    const run = this.running.get(deviceId);
    if (!run) return { ok: false, error: 'This gateway is not polling that device yet' };
    if (!run.driver.browsePoints)
      return { ok: false, error: 'This device cannot list what it can report' };
    try {
      return { ok: true, found: await run.driver.browsePoints() };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message.slice(0, 300) };
    }
  }

  /**
   * One picture from a camera, as base64 for the heartbeat. It is taken now and handed on: nothing
   * is kept here. A picture too large for the cloud to take is refused, with what to do about it.
   */
  async snapshot(
    deviceId: string,
  ): Promise<{ ok: true; contentType: 'image/jpeg'; data: string } | { ok: false; error: string }> {
    const run = this.running.get(deviceId);
    if (!run) return { ok: false, error: 'This gateway is not polling that device yet' };
    if (!run.driver.snapshot) return { ok: false, error: 'This device cannot give a picture' };
    try {
      const shot = await run.driver.snapshot();
      if (shot.bytes.length > MAX_SNAPSHOT_BYTES)
        return {
          ok: false,
          error: 'The picture is too large to send. Lower the camera’s snapshot resolution or quality.',
        };
      return { ok: true, contentType: shot.contentType, data: shot.bytes.toString('base64') };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message.slice(0, 300) };
    }
  }

  shutdown() {
    if (this.addressTimer) clearInterval(this.addressTimer);
    this.addressTimer = null;
    this.prober.stop();
    for (const run of this.running.values()) {
      run.off();
      run.driver.close();
    }
    this.running.clear();
  }
}
