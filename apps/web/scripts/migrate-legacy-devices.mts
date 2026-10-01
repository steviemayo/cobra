// One-off (M7): moves the devices that live inside older room designs into the v2 register.
//
// For every room that has a release, each device in its design becomes a Device row: monitored
// (active) when it has a driver, otherwise a recorded (passive) asset. The address and login
// bindings the room used (including a shared site device's and any credential set's) are split,
// addresses into `values` and logins sealed into `sealed`. A device that already exists in that room
// with the same name is left alone, so the script can be run again.
//
// Run from apps/web:
//   ../gateway/node_modules/.bin/tsx --env-file=../../.env scripts/migrate-legacy-devices.mts            (dry run)
//   ../gateway/node_modules/.bin/tsx --env-file=../../.env scripts/migrate-legacy-devices.mts --apply    (create devices)
//   ... --apply --retire   (also stop the old release running and drop the old device status rows,
//                           so a gateway does not poll each device twice)
//
// Nothing is deleted without --retire. Take a backup first if the database matters.
import { db } from '@kestrel/db';
import { RoomModel, scopeOfSetting, splitSettings, type CustomDrivers } from '@kestrel/model';
import { seal } from '@kestrel/crypto';
import { resolveBindings } from '../src/server/bindings';

const apply = process.argv.includes('--apply');
const retire = process.argv.includes('--retire');
const key = process.env.KESTREL_SECRETS_KEY;

const rooms = await db.room.findMany({ orderBy: { name: 'asc' } });
let created = 0;
let skipped = 0;
let retired = 0;
const problems: string[] = [];

for (const room of rooms) {
  const release = await db.release.findFirst({
    where: { roomId: room.id },
    orderBy: { number: 'desc' },
  });
  if (!release) continue;
  const manifest = (release.manifest as { manifest?: { model?: unknown; drivers?: CustomDrivers } })
    ?.manifest;
  const parsed = RoomModel.safeParse(manifest?.model);
  if (!parsed.success) {
    problems.push(`${room.name}: the latest release could not be read`);
    continue;
  }
  const model = parsed.data;
  const drivers = manifest?.drivers ?? {};
  let bound: Awaited<ReturnType<typeof resolveBindings>>;
  try {
    bound = await resolveBindings(db, room.orgId, room.id, key, model);
  } catch (e) {
    problems.push(`${room.name}: its logins could not be opened (${e instanceof Error ? e.message : String(e)})`);
    continue;
  }
  const existing = await db.device.findMany({ where: { roomId: room.id } });
  console.log(`\n${room.name} (${model.devices.length} devices in release ${release.number})`);
  for (const d of model.devices) {
    if (existing.some((e) => e.name === d.name)) {
      console.log(`  skip     ${d.name} (already in the register)`);
      skipped++;
      continue;
    }
    const { design } = splitSettings(d, drivers);
    const values: Record<string, unknown> = {};
    const secrets: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(bound?.devices[d.id] ?? {})) {
      (scopeOfSetting(d, k, drivers) === 'secret' ? secrets : values)[k] = v;
    }
    const active = !!d.control;
    if (Object.keys(secrets).length > 0 && !key) {
      problems.push(`${room.name} / ${d.name}: it has logins but KESTREL_SECRETS_KEY is not set`);
      continue;
    }
    console.log(`  ${active ? 'monitor ' : 'record  '} ${d.name} (${d.category})${Object.keys(secrets).length ? ' with a login' : ''}`);
    if (apply) {
      const row = await db.device.create({
        data: {
          orgId: room.orgId,
          siteId: room.siteId,
          roomId: room.id,
          name: d.name,
          kind: active ? 'active' : 'passive',
          category: d.category,
          control: (d.control ?? undefined) as never,
          settings: design as never,
          values: values as never,
          sealed: Object.keys(secrets).length ? seal(JSON.stringify(secrets), key!) : null,
        },
      });
      await db.deviceEvent.create({
        data: {
          orgId: room.orgId,
          deviceId: row.id,
          type: 'created',
          newValue: d.name,
          source: 'system',
          data: { note: 'Moved from the room design', release: release.number },
        },
      });
    }
    created++;
  }
  if (apply && retire) {
    const old = await db.deviceStatus.deleteMany({ where: { roomId: room.id } });
    if (room.desiredReleaseId) {
      await db.room.update({ where: { id: room.id }, data: { desiredReleaseId: null, desiredDeploymentId: null } });
      retired++;
    }
    console.log(`  retired the old release and ${old.count} old device status rows`);
  }
}

console.log(`\n${apply ? 'Created' : 'Would create'} ${created}, skipped ${skipped}${retire && apply ? `, retired ${retired} rooms` : ''}.`);
if (!apply) console.log('This was a dry run. Add --apply to make the changes.');
for (const p of problems) console.warn(`Problem: ${p}`);
await db.$disconnect();
