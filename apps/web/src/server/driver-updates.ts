import type { PrismaClient } from '@kestrel/db';
import { RoomModel } from '@kestrel/model';
import { CUSTOM_PREFIX } from './custom-drivers';

// Which rooms are running an older version of one of the organisation's own drivers than the latest
// one. A release pins the exact driver version it was published with, so a driver that is fixed or
// improved does nothing to a room until that room is published and deployed again. A device whose
// design names a driver version on purpose is left alone: someone chose that. These functions take
// the database as a parameter so they can be tested without one.
export type DriverUpdateDb = Pick<PrismaClient, 'room' | 'release' | 'roomDraft' | 'customDriver'>;

export interface DriverUpdate {
  roomId: string;
  roomName: string;
  driver: { slug: string; name: string };
  /** The version the room's release was published with. */
  running: number;
  latest: number;
}

interface ManifestShape {
  manifest?: { drivers?: Record<string, { spec?: { version?: number } }> };
}

/** The version of each custom driver a release pinned, keyed by "custom:slug". */
export function pinnedVersions(manifest: unknown): Record<string, number> {
  const drivers = (manifest as ManifestShape | null)?.manifest?.drivers ?? {};
  const out: Record<string, number> = {};
  for (const [key, d] of Object.entries(drivers)) if (typeof d?.spec?.version === 'number') out[key] = d.spec.version;
  return out;
}

export async function findDriverUpdates(
  db: DriverUpdateDb,
  orgId: string,
  scope: Record<string, unknown> = {},
): Promise<DriverUpdate[]> {
  const drivers = await db.customDriver.findMany({ where: { orgId } });
  if (drivers.length === 0) return [];
  const bySlug = new Map(drivers.map((d) => [`${CUSTOM_PREFIX}${d.slug}`, d]));

  const rooms = await db.room.findMany({ where: { orgId, ...scope }, orderBy: { name: 'asc' } });
  const withRelease = rooms.filter((r) => r.desiredReleaseId);
  if (withRelease.length === 0) return [];
  const [releases, drafts] = await Promise.all([
    db.release.findMany({ where: { orgId, id: { in: withRelease.map((r) => r.desiredReleaseId!) } }, select: { id: true, manifest: true } }),
    db.roomDraft.findMany({ where: { orgId, roomId: { in: withRelease.map((r) => r.id) } }, select: { roomId: true, model: true } }),
  ]);
  const manifest = new Map(releases.map((r) => [r.id, r.manifest]));
  const draft = new Map(drafts.map((d) => [d.roomId, d.model]));

  const out: DriverUpdate[] = [];
  for (const room of withRelease) {
    const pinned = pinnedVersions(manifest.get(room.desiredReleaseId!));
    // Drivers whose version the design names on purpose.
    const chosen = new Set<string>();
    const model = RoomModel.safeParse(draft.get(room.id));
    if (model.success)
      for (const d of model.data.devices)
        if (d.control?.kind === 'driver' && d.control.driverVersion) chosen.add(d.control.driverId);
    for (const [key, version] of Object.entries(pinned)) {
      const driver = bySlug.get(key);
      if (!driver || chosen.has(key) || version >= driver.latestVersion) continue;
      out.push({
        roomId: room.id,
        roomName: room.name,
        driver: { slug: driver.slug, name: driver.name },
        running: version,
        latest: driver.latestVersion,
      });
    }
  }
  return out;
}
