import type { PrismaClient } from '@kestrel/db';
import { inScope, type SiteScope } from './site-scope';

// Which firmware each device in the estate reports. Read only: Kestrel shows what a device says
// about itself and never changes it. A device shows a version only if its driver can ask for one.
export type FirmwareDb = Pick<PrismaClient, 'room' | 'site' | 'deviceStatus'>;

export interface FirmwareRow {
  roomId: string;
  roomName: string;
  siteName: string;
  deviceId: string;
  name: string;
  /** The driver it uses, when the gateway said. */
  driver: string | null;
  /** Null: this device has not reported one (its driver may not be able to). */
  firmware: string | null;
  /** When this version was first seen. */
  firmwareSince: Date | null;
  online: boolean;
}

export interface FirmwareDriverGroup {
  driver: string;
  devices: number;
  /** How many of them reported a version. */
  reporting: number;
  /** Each version in use, most common first. */
  versions: { version: string; count: number }[];
  /** More than one version of the same driver's devices is in use. */
  mixed: boolean;
}

const NO_DRIVER = 'Unknown driver';

/** Every device with the firmware it reported, and a summary by driver. Scoped to the organisation. */
export async function firmwareReport(
  db: FirmwareDb,
  orgId: string,
  /** null: the whole organisation. A list: only rooms at these sites. */
  scope: SiteScope = null,
): Promise<{ rows: FirmwareRow[]; drivers: FirmwareDriverGroup[] }> {
  const [allRooms, sites, statuses] = await Promise.all([
    db.room.findMany({ where: { orgId } }),
    db.site.findMany({ where: { orgId } }),
    db.deviceStatus.findMany({ where: { orgId } }),
  ]);
  const rooms = new Map(allRooms.filter((r) => inScope(scope, r.siteId)).map((r) => [r.id, r]));
  const siteName = new Map(sites.map((s) => [s.id, s.name]));

  const rows: FirmwareRow[] = statuses
    .filter((d) => rooms.has(d.roomId))
    .map((d) => {
      const room = rooms.get(d.roomId)!;
      return {
        roomId: room.id,
        roomName: room.name,
        siteName: siteName.get(room.siteId) ?? '',
        deviceId: d.deviceId,
        name: d.name,
        driver: d.driver ?? null,
        firmware: d.firmware ?? null,
        firmwareSince: d.firmwareSince ?? null,
        online: d.online,
      };
    })
    .sort(
      (a, b) =>
        // Devices with no known driver go last.
        Number(a.driver === null) - Number(b.driver === null) ||
        (a.driver ?? '').localeCompare(b.driver ?? '') ||
        a.siteName.localeCompare(b.siteName) ||
        a.roomName.localeCompare(b.roomName) ||
        a.name.localeCompare(b.name),
    );

  const byDriver = new Map<string, FirmwareRow[]>();
  for (const r of rows) {
    const key = r.driver ?? NO_DRIVER;
    byDriver.set(key, [...(byDriver.get(key) ?? []), r]);
  }
  const drivers: FirmwareDriverGroup[] = [...byDriver].map(([driver, list]) => {
    const counts = new Map<string, number>();
    for (const r of list) if (r.firmware) counts.set(r.firmware, (counts.get(r.firmware) ?? 0) + 1);
    const versions = [...counts]
      .map(([version, count]) => ({ version, count }))
      .sort((a, b) => b.count - a.count || a.version.localeCompare(b.version));
    return {
      driver,
      devices: list.length,
      reporting: list.filter((r) => r.firmware).length,
      versions,
      mixed: versions.length > 1,
    };
  });
  return { rows, drivers };
}
