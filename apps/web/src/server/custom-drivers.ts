import type { PrismaClient } from '@kestrel/db';
import { checkDriverSpec, type DriverSpec, type PinnedDriver, type RoomModel } from '@kestrel/model';

// Custom drivers: written by an organisation in the Kestrel driver format (a data file the gateway
// interprets, never code it runs). Every save is a new immutable version, and a release pins the
// exact version it used.
export type DriverDb = Pick<PrismaClient, 'customDriver' | 'customDriverVersion'>;

export const CUSTOM_PREFIX = 'custom:';
export const MAX_DRIVERS_PER_ORG = 50;
export const MAX_VERSIONS_KEPT = 100;

export type SaveResult =
  | { ok: true; id: string; version: number; created: boolean }
  | { ok: false; problems: string[] };

/**
 * Saves a driver. A new id creates it at version 1; an existing id adds the next version. The
 * version number inside the spec is set here, so nobody can rewrite history by claiming an old one.
 */
export async function saveDriver(
  db: DriverDb,
  input: { orgId: string; raw: unknown; by: string | null },
): Promise<SaveResult> {
  const checked = checkDriverSpec(input.raw);
  if (!checked.ok) return checked;
  const spec = checked.spec;

  const existing = await db.customDriver.findFirst({ where: { orgId: input.orgId, slug: spec.id } });
  if (!existing) {
    const count = await db.customDriver.count({ where: { orgId: input.orgId } });
    if (count >= MAX_DRIVERS_PER_ORG) return { ok: false, problems: [`An organisation can have up to ${MAX_DRIVERS_PER_ORG} drivers`] };
    const created = await db.customDriver.create({
      data: { orgId: input.orgId, slug: spec.id, name: spec.name, latestVersion: 1 },
    });
    await db.customDriverVersion.create({
      data: { driverId: created.id, version: 1, spec: { ...spec, version: 1 } as object, createdBy: input.by },
    });
    return { ok: true, id: created.id, version: 1, created: true };
  }

  const latest = await db.customDriverVersion.findFirst({
    where: { driverId: existing.id, version: existing.latestVersion },
  });
  const next = existing.latestVersion + 1;
  const same = latest && JSON.stringify({ ...(latest.spec as object), version: 0 }) === JSON.stringify({ ...spec, version: 0 });
  if (same) return { ok: true, id: existing.id, version: existing.latestVersion, created: false };
  if (next > MAX_VERSIONS_KEPT) return { ok: false, problems: [`A driver can have up to ${MAX_VERSIONS_KEPT} versions`] };
  await db.customDriverVersion.create({
    data: { driverId: existing.id, version: next, spec: { ...spec, version: next } as object, createdBy: input.by },
  });
  await db.customDriver.update({ where: { id: existing.id }, data: { latestVersion: next, name: spec.name } });
  return { ok: true, id: existing.id, version: next, created: false };
}

export type PinResult =
  | { ok: true; drivers: Record<string, PinnedDriver> }
  | { ok: false; problems: string[] };

/**
 * The custom drivers a design uses, at the version each device names (or the latest), ready to go
 * into a release. A device that names a driver the organisation doesn't have stops the release.
 */
export async function pinDrivers(db: DriverDb, orgId: string, model: RoomModel): Promise<PinResult> {
  const drivers: Record<string, PinnedDriver> = {};
  const problems: string[] = [];
  for (const device of model.devices) {
    const c = device.control;
    if (c?.kind !== 'driver' || !c.driverId.startsWith(CUSTOM_PREFIX)) continue;
    const key = c.driverId;
    const wanted = c.driverVersion ? Number(c.driverVersion) : undefined;
    if (drivers[key] && !wanted) continue;
    const driver = await db.customDriver.findFirst({ where: { orgId, slug: key.slice(CUSTOM_PREFIX.length) } });
    if (!driver) {
      problems.push(`${device.name} uses the driver “${key}”, which this organisation doesn’t have`);
      continue;
    }
    const version = wanted !== undefined && Number.isInteger(wanted) ? wanted : driver.latestVersion;
    const row = await db.customDriverVersion.findFirst({ where: { driverId: driver.id, version } });
    if (!row) {
      problems.push(`${device.name} uses version ${version} of “${key}”, which doesn’t exist`);
      continue;
    }
    const checked = checkDriverSpec(row.spec);
    if (!checked.ok) {
      problems.push(`“${key}” version ${version} is not valid: ${checked.problems[0]}`);
      continue;
    }
    const existing = drivers[key];
    if (existing && existing.version !== version)
      problems.push(`Devices in this room use different versions of “${key}” (${existing.version} and ${version}); use one`);
    else drivers[key] = { version, spec: checked.spec as DriverSpec };
  }
  return problems.length ? { ok: false, problems } : { ok: true, drivers };
}
