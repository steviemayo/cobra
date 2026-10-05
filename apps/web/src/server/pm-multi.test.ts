import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '@kestrel/crypto';
import {
  correctRun,
  createSchedule,
  discardRun,
  exportVisits,
  issuePmReport,
  listRuns,
  listSchedules,
  pmStatus,
  roomsInScope,
  saveRun,
  signRun,
  skipSegment,
  startRun,
  unskipSegment,
  type PmDb,
} from './pm-service';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222221';
const SITE2 = '22222222-2222-4222-8222-222222222222';
const L1 = '44444444-4444-4444-8444-444444444441';
const L2 = '44444444-4444-4444-8444-444444444442';
const WING = '44444444-4444-4444-8444-444444444443';
const R1 = '33333333-3333-4333-8333-333333333331';
const R2 = '33333333-3333-4333-8333-333333333332';
const R3 = '33333333-3333-4333-8333-333333333333';
const R4 = '33333333-3333-4333-8333-333333333334';
const COMBINED = '33333333-3333-4333-8333-333333333335';
const OTHER_SITE_ROOM = '33333333-3333-4333-8333-333333333336';
const D1 = '66666666-6666-4666-8666-666666666661';
const D2 = '66666666-6666-4666-8666-666666666662';
const USER = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-05T10:00:00Z');

const items = [
  { id: 'picture', label: 'Picture is clear', type: 'passfail' },
  { id: 'rack', label: 'Photo of the rack', type: 'photo' },
  { id: 'notes', label: 'Notes', type: 'text' },
];

const room = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  orgId: ORG,
  name,
  siteId: SITE,
  kind: 'standard',
  areaId: null,
  ...extra,
});

function world() {
  const pmRun = table([]);
  const pmPhoto = table([]);
  const pmSchedule = table([]);
  const ticket = table([]);
  const deviceEvent = table([]);
  const db = {
    pmTemplate: table([
      {
        id: 't-room',
        orgId: ORG,
        name: 'Room check',
        appliesTo: 'room',
        category: null,
        items,
        version: 1,
      },
      {
        id: 't-disp',
        orgId: ORG,
        name: 'Display check',
        appliesTo: 'device',
        category: 'display',
        items,
        version: 1,
      },
    ]),
    pmRun,
    pmPhoto,
    pmSchedule,
    site: table([
      { id: SITE, orgId: ORG, name: 'Head office' },
      { id: SITE2, orgId: ORG, name: 'Warehouse' },
    ]),
    area: table([
      { id: L1, orgId: ORG, siteId: SITE, parentId: null, name: 'Level 1' },
      { id: L2, orgId: ORG, siteId: SITE, parentId: null, name: 'Level 2' },
      { id: WING, orgId: ORG, siteId: SITE, parentId: L1, name: 'East wing' },
    ]),
    room: table([
      room(R1, 'Boardroom', { areaId: L1 }),
      room(R2, 'Training', { areaId: WING }),
      room(R3, 'Huddle', { areaId: L2 }),
      room(R4, 'Lobby'),
      room(COMBINED, 'Boardroom + Training', { kind: 'combined', areaId: L1 }),
      room(OTHER_SITE_ROOM, 'Dock', { siteId: SITE2 }),
    ]),
    device: table([
      {
        id: D1,
        orgId: ORG,
        name: 'Lobby screen',
        roomId: R4,
        category: 'display',
        kind: 'active',
        online: true,
      },
      {
        id: D2,
        orgId: ORG,
        name: 'Boardroom screen',
        roomId: R1,
        category: 'display',
        kind: 'active',
        online: true,
      },
      {
        id: 'cam',
        orgId: ORG,
        name: 'Camera',
        roomId: R1,
        category: 'camera',
        kind: 'active',
        online: true,
      },
    ]),
    incident: table([]),
    ticket,
    org: table([{ id: ORG, name: 'Acme AV' }]),
    registerIssue: table([]),
    deviceEvent,
  } as unknown as PmDb;
  return { db, pmRun, pmPhoto, pmSchedule, ticket, deviceEvent };
}
type World = ReturnType<typeof world>;

async function siteSchedule(w: World, templateId = 't-room', extra: Record<string, unknown> = {}) {
  const r = await createSchedule(w.db, {
    orgId: ORG,
    templateId,
    scope: 'site',
    siteId: SITE,
    intervalDays: 90,
    firstDueOn: NOW,
    userId: USER,
    ...extra,
  });
  if (!r.ok) throw new Error(r.message);
  return r.value.id;
}

async function startSite(w: World) {
  const scheduleId = await siteSchedule(w);
  const r = await startRun(
    w.db,
    { orgId: ORG, templateId: 't-room', scheduleId, userId: USER },
    NOW,
  );
  if (!r.ok) throw new Error(r.message);
  return { scheduleId, runId: r.value.id };
}

const segmentsOf = (w: World, runId: string) =>
  w.pmRun.rows.filter((r) => r.parentRunId === runId) as {
    id: string;
    roomId: string;
    status: string;
    results: { itemId: string; label: string; type: string; result: unknown }[];
  }[];

const answer = (w: World, segId: string, result: 'pass' | 'fail') =>
  saveRun(w.db, {
    orgId: ORG,
    runId: segId,
    userId: USER,
    userName: 'Sam Tech',
    results: [
      { itemId: 'picture', label: 'Picture is clear', type: 'passfail', result },
      { itemId: 'rack', label: 'Photo of the rack', type: 'photo', result: null },
      { itemId: 'notes', label: 'Notes', type: 'text', result: null },
    ],
  });

const sign = (w: World, runId: string, raiseTicket = true) =>
  signRun(
    w.db,
    { orgId: ORG, runId, userId: USER, name: 'Sam Tech', raiseTicket, markInRepair: false },
    NOW,
  );

describe('what a scope covers', () => {
  it('a site covers its ordinary rooms and not combined spaces or other sites', async () => {
    const w = world();
    const r = await roomsInScope(w.db, ORG, { scope: 'site', siteId: SITE });
    expect(r.ok && r.value.rooms.map((x) => x.name)).toEqual([
      'Boardroom',
      'Huddle',
      'Lobby',
      'Training',
    ]);
    expect(r.ok && r.value.label).toBe('Site: Head office');
  });

  it('an area covers the rooms inside it and in the areas beneath it', async () => {
    const w = world();
    const r = await roomsInScope(w.db, ORG, { scope: 'area', areaId: L1 });
    expect(r.ok && r.value.rooms.map((x) => x.name)).toEqual(['Boardroom', 'Training']);
    expect(r.ok && r.value.label).toBe('Area: Level 1');
  });

  it('a hand-picked list needs two rooms that exist', async () => {
    const w = world();
    expect((await roomsInScope(w.db, ORG, { scope: 'rooms', roomIds: [R1] })).ok).toBe(false);
    expect((await roomsInScope(w.db, ORG, { scope: 'rooms', roomIds: [R1, 'nope'] })).ok).toBe(
      false,
    );
    const ok = await roomsInScope(w.db, ORG, { scope: 'rooms', roomIds: [R1, R3] });
    expect(ok.ok && ok.value.label).toBe('2 rooms');
  });
});

describe('a visit to several rooms', () => {
  it('starts one visit with a segment for each room, each with its own answers', async () => {
    const w = world();
    const { runId } = await startSite(w);
    const parent = w.pmRun.rows.find((r) => r.id === runId)!;
    expect(parent).toMatchObject({
      multi: true,
      roomId: null,
      status: 'draft',
      scopeLabel: 'Site: Head office',
    });
    expect(parent.dueOn).toEqual(new Date('2026-10-05T00:00:00Z'));
    const segs = segmentsOf(w, runId);
    expect(segs.map((s) => s.roomId).sort()).toEqual([R1, R2, R3, R4].sort());
    expect(segs.every((s) => s.status === 'draft' && s.results.length === 3)).toBe(true);
  });

  it('asking again for the same schedule goes back to the open visit', async () => {
    const w = world();
    const { scheduleId, runId } = await startSite(w);
    const again = await startRun(
      w.db,
      { orgId: ORG, templateId: 't-room', scheduleId, userId: USER },
      NOW,
    );
    expect(again.ok && again.value.id).toBe(runId);
    expect(w.pmRun.rows.filter((r) => r.multi)).toHaveLength(1);
  });

  it('a device checklist makes a segment for each matching device only', async () => {
    const w = world();
    const scheduleId = await siteSchedule(w, 't-disp');
    const r = await startRun(
      w.db,
      { orgId: ORG, templateId: 't-disp', scheduleId, userId: USER },
      NOW,
    );
    expect(r.ok).toBe(true);
    const segs = w.pmRun.rows.filter((x) => x.parentRunId === (r.ok ? r.value.id : ''));
    expect(segs.map((s) => s.deviceId).sort()).toEqual([D1, D2].sort());
    expect(segs.find((s) => s.deviceId === D2)!.roomId).toBe(R1);
  });

  it('cannot be scheduled where there is nothing to check', async () => {
    const w = world();
    const r = await createSchedule(w.db, {
      orgId: ORG,
      templateId: 't-disp',
      scope: 'area',
      areaId: L2,
      intervalDays: 90,
      firstDueOn: NOW,
      userId: USER,
    });
    expect(r.ok).toBe(false);
  });

  it('will not sign until every room is answered, and names the rooms that are not', async () => {
    const w = world();
    const { runId } = await startSite(w);
    const [first] = segmentsOf(w, runId);
    await answer(w, first!.id, 'pass');
    const r = await sign(w, runId);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/Still to answer in 3 rooms/);
    expect(w.pmRun.rows.find((x) => x.id === runId)!.status).toBe('draft');
  });

  it('a room can be skipped with a reason, brought back, and does not hold up the rest', async () => {
    const w = world();
    const { runId } = await startSite(w);
    const [a, b, c, d] = segmentsOf(w, runId);
    expect((await skipSegment(w.db, { orgId: ORG, runId: d!.id, reason: ' ' })).ok).toBe(false);
    expect(
      (await skipSegment(w.db, { orgId: ORG, runId: d!.id, reason: 'Locked, key holder away' })).ok,
    ).toBe(true);
    expect((await unskipSegment(w.db, { orgId: ORG, runId: d!.id })).ok).toBe(true);
    expect(w.pmRun.rows.find((x) => x.id === d!.id)).toMatchObject({
      status: 'draft',
      skipReason: null,
    });
    await skipSegment(w.db, { orgId: ORG, runId: d!.id, reason: 'Locked, key holder away' });
    for (const s of [a, b, c]) await answer(w, s!.id, 'pass');
    expect((await saveRun(w.db, { orgId: ORG, runId: d!.id, results: [] })).ok).toBe(false);
    const r = await sign(w, runId);
    expect(r.ok).toBe(true);
    const after = segmentsOf(w, runId);
    expect(after.filter((s) => s.status === 'signed')).toHaveLength(3);
    expect(after.find((s) => s.id === d!.id)!.status).toBe('skipped');
  });

  it('signing raises a ticket for each room that failed and moves the schedule on once', async () => {
    const w = world();
    const { runId, scheduleId } = await startSite(w);
    const segs = segmentsOf(w, runId);
    await answer(w, segs[0]!.id, 'fail');
    await answer(w, segs[1]!.id, 'fail');
    await answer(w, segs[2]!.id, 'pass');
    await answer(w, segs[3]!.id, 'pass');
    const r = await sign(w, runId);
    expect(r.ok && r.value).toMatchObject({ failed: 2, tickets: 2 });
    expect(w.ticket.rows.map((t) => t.roomId).sort()).toEqual(
      [segs[0]!.roomId, segs[1]!.roomId].sort(),
    );
    const parent = w.pmRun.rows.find((x) => x.id === runId)!;
    expect(parent).toMatchObject({ status: 'signed', failedCount: 2, signedByName: 'Sam Tech' });
    const sch = w.pmSchedule.rows.find((x) => x.id === scheduleId)!;
    expect((sch.nextDueOn as Date).getTime()).toBeGreaterThan(NOW.getTime());
    expect(sch.lastRunOn).toBeTruthy();
  });

  it('records who worked on each room', async () => {
    const w = world();
    const { runId } = await startSite(w);
    const [a] = segmentsOf(w, runId);
    await answer(w, a!.id, 'pass');
    expect(w.pmRun.rows.find((x) => x.id === a!.id)).toMatchObject({
      workedBy: USER,
      workedByName: 'Sam Tech',
    });
  });

  it('is signed and discarded as a whole, never one room at a time', async () => {
    const w = world();
    const { runId } = await startSite(w);
    const [a] = segmentsOf(w, runId);
    expect((await sign(w, a!.id)).ok).toBe(false);
    expect((await discardRun(w.db, ORG, a!.id)).ok).toBe(false);
    w.pmPhoto.rows.push({ id: 'p', orgId: ORG, runId: a!.id, itemId: 'rack' });
    expect((await discardRun(w.db, ORG, runId)).ok).toBe(true);
    expect(w.pmRun.rows).toHaveLength(0);
    expect(w.pmPhoto.rows).toHaveLength(0);
  });

  it('is corrected as a whole, copying each room, and the correction replaces it', async () => {
    const w = world();
    const { runId } = await startSite(w);
    const segs = segmentsOf(w, runId);
    await skipSegment(w.db, { orgId: ORG, runId: segs[3]!.id, reason: 'Locked' });
    for (const s of segs.slice(0, 3)) await answer(w, s.id, 'pass');
    await sign(w, runId, false);
    expect(
      (
        await correctRun(w.db, {
          orgId: ORG,
          runId: segs[0]!.id,
          userId: USER,
          reason: 'Wrong room',
        })
      ).ok,
    ).toBe(false);
    const c = await correctRun(
      w.db,
      { orgId: ORG, runId, userId: USER, reason: 'Wrong answer' },
      NOW,
    );
    expect(c.ok && c.value.existing).toBe(false);
    const fix = w.pmRun.rows.find((x) => x.id === (c.ok ? c.value.id : ''))!;
    expect(fix).toMatchObject({
      multi: true,
      correctsRunId: runId,
      scheduleId: null,
      dueOn: null,
      status: 'draft',
    });
    const copies = segmentsOf(w, fix.id as string);
    expect(copies).toHaveLength(4);
    expect(copies.filter((x) => x.status === 'skipped')).toHaveLength(1);
    expect(copies.find((x) => x.roomId === segs[0]!.roomId)!.results[0]!.result).toBe('pass');
    // Open one is returned if asked again.
    const again = await correctRun(
      w.db,
      { orgId: ORG, runId, userId: USER, reason: 'Wrong answer' },
      NOW,
    );
    expect(again.ok && again.value.existing).toBe(true);
  });
});

describe('the list of visits', () => {
  async function signedSite() {
    const w = world();
    const { runId } = await startSite(w);
    const segs = segmentsOf(w, runId);
    await skipSegment(w.db, { orgId: ORG, runId: segs[3]!.id, reason: 'Locked' });
    for (const s of segs.slice(0, 3)) await answer(w, s.id, 'pass');
    await answer(w, segs[0]!.id, 'fail');
    await sign(w, runId, false);
    return { w, runId, segs };
  }

  it('shows one row for the whole visit, with each room as a segment, and its site', async () => {
    const { w, runId } = await signedSite();
    const list = await listRuns(w.db, ORG);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: runId,
      multi: true,
      scopeLabel: 'Site: Head office',
      siteName: 'Head office',
      status: 'signed',
      failedCount: 1,
    });
    expect(list[0]!.segments.map((s) => s.status).sort()).toEqual([
      'signed',
      'signed',
      'signed',
      'skipped',
    ]);
    expect(list[0]!.segments.find((s) => s.status === 'skipped')!.skipReason).toBe('Locked');
  });

  it("a room's own list has its segment, pointing at the visit", async () => {
    const { w, runId, segs } = await signedSite();
    const list = await listRuns(w.db, ORG, { roomId: segs[1]!.roomId });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      parentRunId: runId,
      parentLabel: 'Site: Head office',
      multi: false,
    });
  });

  it('only shows rooms a site-limited reader may see', async () => {
    const { w, segs } = await signedSite();
    const only = new Set([segs[0]!.roomId]);
    const list = await listRuns(w.db, ORG, {}, only);
    expect(list[0]!.segments).toHaveLength(1);
    expect(await listRuns(w.db, ORG, {}, new Set([OTHER_SITE_ROOM]))).toHaveLength(0);
  });

  it('counts the visit once in the status, not once per room', async () => {
    const { w } = await signedSite();
    const s = await pmStatus(w.db, ORG, NOW);
    expect(s.schedules).toBe(1);
    expect(s.onTimePct).toBe(100);
    const mine = await pmStatus(w.db, ORG, NOW, new Set([R1]));
    expect(mine.schedules).toBe(1);
    expect((await pmStatus(w.db, ORG, NOW, new Set([OTHER_SITE_ROOM]))).schedules).toBe(0);
  });

  it('exports every answer by room, and a skipped room has none', async () => {
    const { w } = await signedSite();
    const rackId = w.pmRun.rows.find((r) => r.parentRunId && r.status === 'signed')!.id as string;
    w.pmPhoto.rows.push({
      id: 'ph1',
      orgId: ORG,
      runId: rackId,
      itemId: 'rack',
      mime: 'image/jpeg',
      size: 10,
      sha256: 'ab',
      createdAt: NOW,
    });
    const out = await exportVisits(w.db, ORG, {});
    expect(out).toHaveLength(1);
    expect(out[0]!.sections).toHaveLength(4);
    const done = out[0]!.sections.filter((s) => s.status === 'signed');
    expect(done.every((s) => s.results.length === 3)).toBe(true);
    expect(out[0]!.sections.find((s) => s.status === 'skipped')!.results).toEqual([]);
    expect(done.flatMap((s) => s.photos)).toEqual([
      expect.objectContaining({ id: 'ph1', itemId: 'rack', itemLabel: 'Photo of the rack' }),
    ]);
    expect(out[0]!.sections.find((s) => s.status === 'skipped')!.photos).toEqual([]);
    const one = await exportVisits(w.db, ORG, { runId: out[0]!.id });
    expect(one).toHaveLength(1);
  });

  it('is listed in a signed report with each room as a segment, counted once', async () => {
    const { w } = await signedSite();
    const rep = await issuePmReport(
      w.db,
      {
        orgId: ORG,
        from: new Date('2026-10-01T00:00:00Z'),
        to: new Date('2026-10-31T00:00:00Z'),
        userId: USER,
      },
      { ...generateKeyPair(), keyId: 'k1' },
      NOW,
    );
    expect(rep.ok).toBe(true);
    const issue = (
      w.db.registerIssue as unknown as {
        rows: {
          payload: {
            payload: {
              summary: { visits: number };
              runs: { scope?: string; segments?: { status: string }[] }[];
            };
          };
        }[];
      }
    ).rows[0]!;
    expect(issue.payload.payload.summary.visits).toBe(1);
    expect(issue.payload.payload.runs[0]!.scope).toBe('Site: Head office');
    expect(issue.payload.payload.runs[0]!.segments).toHaveLength(4);
  });
});

describe('schedules', () => {
  it('lists a site schedule with what it covers, and finds it from a room it includes', async () => {
    const w = world();
    await siteSchedule(w);
    const all = await listSchedules(w.db, ORG, NOW);
    expect(all[0]).toMatchObject({ scope: 'site', scopeLabel: 'Site: Head office', roomCount: 4 });
    expect(await listSchedules(w.db, ORG, NOW, { roomId: R2 })).toHaveLength(1);
    expect(await listSchedules(w.db, ORG, NOW, { roomId: OTHER_SITE_ROOM })).toHaveLength(0);
  });

  it('shows the open visit so the page can offer Continue', async () => {
    const w = world();
    const { scheduleId, runId } = await startSite(w);
    expect((await listSchedules(w.db, ORG, NOW))[0]).toMatchObject({
      id: scheduleId,
      openRunId: runId,
    });
  });
});

describe('a one-time check', () => {
  it('switches itself off once signed, leaves the list, and no longer blocks its checklist', async () => {
    const w = world();
    const made = await createSchedule(w.db, {
      orgId: ORG,
      templateId: 't-room',
      scope: 'site',
      siteId: SITE,
      oneOff: true,
      intervalDays: 0,
      firstDueOn: NOW,
      userId: USER,
    });
    expect(made.ok).toBe(true);
    const scheduleId = made.ok ? made.value.id : '';
    expect(w.pmSchedule.rows[0]).toMatchObject({ oneOff: true, intervalDays: 0, enabled: true });
    const started = await startRun(
      w.db,
      { orgId: ORG, templateId: 't-room', scheduleId, userId: USER },
      NOW,
    );
    const runId = started.ok ? started.value.id : '';
    for (const s of segmentsOf(w, runId)) await answer(w, s.id, 'pass');
    expect((await sign(w, runId)).ok).toBe(true);
    expect(w.pmSchedule.rows[0]).toMatchObject({ enabled: false });
    expect(w.pmSchedule.rows[0]!.lastRunOn).toBeTruthy();
    expect(await listSchedules(w.db, ORG, NOW)).toHaveLength(0);
    expect((await pmStatus(w.db, ORG, NOW)).schedules).toBe(0);
  });

  it('a single room one-off needs no interval', async () => {
    const w = world();
    const r = await createSchedule(w.db, {
      orgId: ORG,
      templateId: 't-room',
      roomId: R1,
      oneOff: true,
      intervalDays: 0,
      firstDueOn: NOW,
      userId: USER,
    });
    expect(r.ok).toBe(true);
    const bad = await createSchedule(w.db, {
      orgId: ORG,
      templateId: 't-room',
      roomId: R1,
      intervalDays: 0,
      firstDueOn: NOW,
      userId: USER,
    });
    expect(bad.ok).toBe(false);
  });
});
