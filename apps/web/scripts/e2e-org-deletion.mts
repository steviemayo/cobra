// Manual end-to-end check of deleting an organisation, against the real database. It makes two
// throwaway organisations, schedules one for deletion, restores it, schedules it again, brings its
// day forward, runs the clean-up, and checks that nothing of it is left (including the tables that
// do not cascade) and that the other organisation is untouched. Both are removed at the end.
//
// Run from apps/web:
//   ../gateway/node_modules/.bin/tsx --env-file=../../.env scripts/e2e-org-deletion.mts
import { randomUUID } from 'node:crypto';
import { db } from '@kestrel/db';
import {
  PURGED_BY_ORG_ID,
  purgeDueOrgs,
  restoreOrg,
  scheduleDeletion,
} from '../src/server/org-deletion.ts';

const tag = randomUUID().slice(0, 8);
let failures = 0;
let checks = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  checks++;
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}`, detail ?? '');
  }
}

async function makeOrg(label: string) {
  const org = await db.org.create({ data: { name: `E2E ${label} ${tag}` } });
  const site = await db.site.create({ data: { orgId: org.id, name: 'HQ' } });
  const room = await db.room.create({
    data: { orgId: org.id, siteId: site.id, name: 'Boardroom', type: 'meeting' },
  });
  await db.gateway.create({
    data: {
      orgId: org.id,
      siteId: site.id,
      name: 'GW',
      credentialHash: `e2e-${tag}-${label}`,
      enrollTokenHash: `tok-${tag}-${label}`,
    },
  });
  // Tables with an orgId but no relation to the organisation: these do not cascade.
  await db.maintenanceWindow.create({
    data: {
      orgId: org.id,
      name: 'W',
      scope: 'org',
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 3600_000),
    },
  });
  await db.roomSchedule.create({
    data: { roomId: room.id, orgId: org.id, meetings: [], fetchedAt: new Date() },
  });
  await db.calendarFire.create({
    data: { orgId: org.id, roomId: room.id, triggerId: 't', eventKey: `k-${label}` },
  });
  await db.ticketRule.create({ data: { orgId: org.id, name: 'R' } });
  return { org, site, room };
}

const counts = async (orgId: string) => ({
  org: await db.org.count({ where: { id: orgId } }),
  site: await db.site.count({ where: { orgId } }),
  room: await db.room.count({ where: { orgId } }),
  gateway: await db.gateway.count({ where: { orgId } }),
  maintenanceWindow: await db.maintenanceWindow.count({ where: { orgId } }),
  roomSchedule: await db.roomSchedule.count({ where: { orgId } }),
  calendarFire: await db.calendarFire.count({ where: { orgId } }),
  ticketRule: await db.ticketRule.count({ where: { orgId } }),
});

const staffUserId = randomUUID();
let a: Awaited<ReturnType<typeof makeOrg>> | null = null;
let b: Awaited<ReturnType<typeof makeOrg>> | null = null;
try {
  a = await makeOrg('gone');
  b = await makeOrg('stays');
  console.log('Scheduling');
  const cancelled: string[] = [];
  const out = await scheduleDeletion(
    db,
    { cancelSubscription: async (id) => void cancelled.push(id) },
    { orgId: a.org.id, staffUserId, confirmName: a.org.name, reason: 'e2e' },
  );
  ok('one gateway released', out.gatewaysReleased === 1, out);
  const gw = await db.gateway.findFirst({ where: { orgId: a.org.id } });
  ok(
    'its gateway has no credential or token',
    gw?.credentialHash === null && gw?.enrollTokenHash === null,
    gw,
  );
  const flagged = await db.org.findFirst({ where: { id: a.org.id } });
  ok(
    'it is flagged with a day 30 days out',
    !!flagged?.deletedAt && !!flagged.deleteAfter && flagged.deletedBy === staffUserId,
    flagged,
  );
  const other = await db.gateway.findFirst({ where: { orgId: b.org.id } });
  ok(
    'the other organisation’s gateway is untouched',
    other?.credentialHash === `e2e-${tag}-stays`,
    other,
  );

  console.log('Restoring');
  await restoreOrg(db, { orgId: a.org.id });
  const back = await db.org.findFirst({ where: { id: a.org.id } });
  ok(
    'restored: not flagged any more',
    back?.deletedAt === null && back?.deleteAfter === null,
    back,
  );

  console.log('Scheduling again, bringing the day forward, running the clean-up');
  await scheduleDeletion(
    db,
    { cancelSubscription: async () => undefined },
    { orgId: a.org.id, staffUserId, confirmName: a.org.name, reason: 'e2e again' },
  );
  const early = await purgeDueOrgs(db);
  ok('not due yet: nothing deleted', !early.purged.includes(a.org.id), early);
  await db.org.update({
    where: { id: a.org.id },
    data: { deleteAfter: new Date(Date.now() - 1000) },
  });
  const summary = await purgeDueOrgs(db);
  ok(
    'the clean-up deleted it',
    summary.purged.includes(a.org.id) && summary.failed.length === 0,
    summary,
  );

  const left = await counts(a.org.id);
  ok(
    'nothing of it is left, in any table',
    Object.values(left).every((n) => n === 0),
    left,
  );
  const kept = await counts(b.org.id);
  ok(
    'the other organisation is whole',
    Object.values(kept).every((n) => n === 1),
    kept,
  );
  const audit = await db.staffAudit.findFirst({
    where: { orgId: a.org.id, action: 'org.delete.purge' },
  });
  ok(
    'the staff audit trail kept a record with its name',
    (audit?.meta as { name?: string } | null)?.name === a.org.name,
    audit,
  );
  ok('every non-cascading table is cleared by the purge', PURGED_BY_ORG_ID.length > 0);
} finally {
  for (const x of [a, b]) {
    if (!x) continue;
    const tables = db as never as Record<
      string,
      { deleteMany: (a: object) => Promise<unknown> }
    >;
    for (const t of PURGED_BY_ORG_ID)
      await tables[t]!.deleteMany({ where: { orgId: x.org.id } }).catch(() => undefined);
    await db.org.deleteMany({ where: { id: x.org.id } });
  }
  await db.staffAudit.deleteMany({ where: { staffUserId } });
}
console.log(`\n${checks - failures} of ${checks} checks passed`);
process.exit(failures ? 1 : 0);
