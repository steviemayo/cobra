import type { DeviceDetailSection, DeviceState } from '@kestrel/model';
import { CrestronCwsMonitor } from './crestron-cws';
import { deviceSection, plainRows } from './crestron-details';
import { digPath, isRecord } from './cresnext';

// A Crestron occupancy sensor (the CEN-ODT and GLS-ODT families and similar), watched over the
// CresNext REST API: the same login and /Device tree as the other Crestron units (crestron-cws.ts).
// Monitoring only.
//
// Settings: host, username, password, protocol ("https"), port (443), allowSelfSigned (true),
// pollMs (15000), timeoutMs (4000), occupiedPath (optional: a dotted path to the boolean that means
// "someone is in the room", when the sensor does not name it the usual way).
//
// NOT YET VERIFIED AGAINST A REAL SENSOR. Everything below that names a field is a best reading of
// the CresNext documentation, so the driver is built to degrade rather than guess: the occupied
// state is the sensor's `Device.OccupancySensor` boolean whose name says occupied/occupancy (or
// `occupiedPath`), and the details page lists every plain value in that object exactly as the
// sensor reports it, so nothing has to be named in advance to be seen.
//
// Occupancy changes should be noticed quickly, so besides the regular poll it long-polls the sensor
// (`GET /Device/OccupancySensor/Longpoll`): the request is held open until something changes and
// answers with only the changed properties. On the units it was tried on (a 4-series processor and
// a touch panel) every long-poll also fires on the device clock, about once a second, so a change
// counts only when it is about something other than SystemClock.

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

const OCCUPIED_KEY = /^(is)?(room)?(occupied|occupancy)(detected|status|state)?$/i;

/** Whether a long-poll answer says anything besides the device clock ticking over. */
export function meansChange(delta: unknown): boolean {
  const device = isRecord(delta) ? delta.Device : undefined;
  return isRecord(device) && Object.keys(device).some((k) => k !== 'SystemClock');
}

export class CrestronOccupancyDriver extends CrestronCwsMonitor {
  private watching = false;

  protected applyFeedback(tree: unknown, s: DeviceState): void {
    const info = digPath(tree, 'Device.DeviceInfo');
    if (isRecord(info) && typeof info.DeviceVersion === 'string') s.firmware = info.DeviceVersion;

    const sensor = digPath(tree, 'Device.OccupancySensor');
    const override = this.setting<string>('occupiedPath', '');
    const explicit = override ? digPath(tree, override) : undefined;
    const named = isRecord(sensor)
      ? Object.entries(sensor).find(([k, v]) => OCCUPIED_KEY.test(k) && typeof v === 'boolean')?.[1]
      : undefined;
    const occupied = typeof explicit === 'boolean' ? explicit : named;
    if (typeof occupied === 'boolean') s.occupied = occupied;

    const sections: DeviceDetailSection[] = [];
    const device = deviceSection(tree);
    if (device) sections.push(device);
    if (isRecord(sensor)) {
      const rows = plainRows(sensor, 40);
      if (rows.length) sections.push({ title: 'Occupancy sensor', rows });
    }
    s.details = sections;
  }

  override start() {
    super.start();
    if (!this.setting<string>('host', '') || this.watching) return;
    this.watching = true;
    void this.watch();
  }

  override close() {
    this.watching = false;
    super.close();
  }

  /** Holds a long-poll open and reads the whole sensor again whenever it reports a real change. */
  private async watch() {
    while (this.watching) {
      try {
        const delta = await this.ensureSession().longpoll('/Device/OccupancySensor/Longpoll');
        if (!this.watching) return;
        if (meansChange(delta)) await this.refresh();
        // Even a clock-only answer comes back at once, so leave the unit alone for a moment.
        await sleep(750);
      } catch {
        // No long poll here (or unreachable): the regular poll carries on alone; try again later.
        await sleep(30_000);
      }
    }
  }
}
