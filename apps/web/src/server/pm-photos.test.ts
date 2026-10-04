import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '@kestrel/crypto';
import {
  PM_PHOTO_MAX_BYTES,
  PM_PHOTO_MAX_PER_ITEM,
  addPhoto,
  correctRun,
  correctionsOf,
  getPhoto,
  issuePmReport,
  listPhotos,
  looksLikeImage,
  removePhoto,
  saveRun,
  signRun,
  startRun,
  type PmDb,
} from './pm-service';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const ROOM = '33333333-3333-4333-8333-333333333331';
const USER = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-04T10:00:00Z');

const items = [
  { id: 'picture', label: 'Picture is clear', type: 'passfail' },
  { id: 'rack', label: 'Photo of the rack', type: 'photo' },
  { id: 'notes', label: 'Notes', type: 'text' },
];

/** The first bytes of a real JPEG, then filler. */
const jpeg = (size = 64) => {
  const b = Buffer.alloc(size, 7);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  return b;
};
const b64 = (b: Buffer) => b.toString('base64');

async function world() {
  const pmTemplate = table([
    {
      id: 't1',
      orgId: ORG,
      name: 'Room check',
      appliesTo: 'room',
      items,
      version: 1,
    },
  ]);
  const pmRun = table([]);
  const pmPhoto = table([]);
  const pmSchedule = table([
    { id: 's1', orgId: ORG, templateId: 't1', roomId: ROOM, intervalDays: 90, nextDueOn: NOW },
  ]);
  const deviceEvent = table([]);
  const db = {
    pmTemplate,
    pmRun,
    pmPhoto,
    pmSchedule,
    room: table([{ id: ROOM, orgId: ORG, name: 'Boardroom', siteId: 's' }]),
    device: table([]),
    incident: table([]),
    ticket: table([]),
    org: table([{ id: ORG, name: 'Acme AV' }]),
    registerIssue: table([]),
    deviceEvent,
  } as unknown as PmDb;
  const started = await startRun(
    db,
    { orgId: ORG, templateId: 't1', roomId: ROOM, userId: USER },
    NOW,
  );
  if (!started.ok) throw new Error(started.message);
  return { db, pmRun, pmPhoto, pmSchedule, deviceEvent, runId: started.value.id };
}

const sign = (w: Awaited<ReturnType<typeof world>>, runId: string, name = 'Sam Tech') =>
  signRun(
    w.db,
    { orgId: ORG, runId, userId: USER, name, raiseTicket: false, markInRepair: false },
    NOW,
  );

async function signedRun() {
  const w = await world();
  await saveRun(w.db, {
    orgId: ORG,
    runId: w.runId,
    results: [
      { itemId: 'picture', label: 'Picture is clear', type: 'passfail', result: 'pass' },
      { itemId: 'rack', label: 'Photo of the rack', type: 'photo', result: null },
      { itemId: 'notes', label: 'Notes', type: 'text', result: null },
    ],
    notes: 'All fine',
  });
  const added = await addPhoto(w.db, {
    orgId: ORG,
    runId: w.runId,
    itemId: 'rack',
    mime: 'image/jpeg',
    data: b64(jpeg()),
    userId: USER,
  });
  expect(added.ok).toBe(true);
  expect((await sign(w, w.runId)).ok).toBe(true);
  return w;
}

describe('image check', () => {
  it('accepts the real first bytes of each type and nothing else', () => {
    expect(looksLikeImage('image/jpeg', jpeg())).toBe(true);
    expect(looksLikeImage('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]))).toBe(true);
    const webp = Buffer.from('RIFF\0\0\0\0WEBP');
    expect(looksLikeImage('image/webp', webp)).toBe(true);
    expect(looksLikeImage('image/jpeg', Buffer.from('<script>alert(1)</script>'))).toBe(false);
    expect(looksLikeImage('image/png', jpeg())).toBe(false);
    expect(looksLikeImage('image/gif', jpeg())).toBe(false);
  });
});

describe('photos on a visit', () => {
  it('adds a photo to a photo item, with its size and SHA-256', async () => {
    const w = await world();
    const r = await addPhoto(w.db, {
      orgId: ORG,
      runId: w.runId,
      itemId: 'rack',
      mime: 'image/jpeg',
      data: b64(jpeg(100)),
      userId: USER,
    });
    expect(r.ok).toBe(true);
    const list = await listPhotos(w.db, ORG, w.runId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ itemId: 'rack', mime: 'image/jpeg', size: 100 });
    expect(list[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hands the picture back as a data address', async () => {
    const w = await world();
    const r = await addPhoto(w.db, {
      orgId: ORG,
      runId: w.runId,
      itemId: 'rack',
      mime: 'image/jpeg',
      data: b64(jpeg()),
      userId: USER,
    });
    const got = await getPhoto(w.db, {
      orgId: ORG,
      runId: w.runId,
      photoId: (r as { value: { id: string } }).value.id,
    });
    expect(got.ok && got.value.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('refuses an item that is not a photo item, an unknown item, other types, and other files', async () => {
    const w = await world();
    const base = { orgId: ORG, runId: w.runId, userId: USER };
    const add = (over: Record<string, unknown>) =>
      addPhoto(w.db, {
        ...base,
        itemId: 'rack',
        mime: 'image/jpeg',
        data: b64(jpeg()),
        ...over,
      } as never);
    expect(await add({ itemId: 'picture' })).toMatchObject({
      ok: false,
      message: /does not take photos/,
    });
    expect(await add({ itemId: 'nope' })).toMatchObject({ ok: false });
    expect(await add({ mime: 'image/gif' })).toMatchObject({
      ok: false,
      message: /JPEG, PNG or WebP/,
    });
    expect(await add({ data: b64(Buffer.from('not an image at all')) })).toMatchObject({
      ok: false,
      message: /not a valid image/,
    });
    expect(await add({ data: '' })).toMatchObject({ ok: false, message: /empty/ });
  });

  it('refuses a photo that is too large, and a fifth photo on one item', async () => {
    const w = await world();
    const big = await addPhoto(w.db, {
      orgId: ORG,
      runId: w.runId,
      itemId: 'rack',
      mime: 'image/jpeg',
      data: b64(jpeg(PM_PHOTO_MAX_BYTES + 1)),
      userId: USER,
    });
    expect(big).toMatchObject({ ok: false, message: /too large/ });
    for (let i = 0; i < PM_PHOTO_MAX_PER_ITEM; i++)
      expect(
        (
          await addPhoto(w.db, {
            orgId: ORG,
            runId: w.runId,
            itemId: 'rack',
            mime: 'image/jpeg',
            data: b64(jpeg(10 + i)),
            userId: USER,
          })
        ).ok,
      ).toBe(true);
    expect(
      await addPhoto(w.db, {
        orgId: ORG,
        runId: w.runId,
        itemId: 'rack',
        mime: 'image/jpeg',
        data: b64(jpeg(99)),
        userId: USER,
      }),
    ).toMatchObject({ ok: false, message: /up to 4/ });
  });

  it('only touches visits of the same organisation', async () => {
    const w = await world();
    expect(
      await addPhoto(w.db, {
        orgId: OTHER_ORG,
        runId: w.runId,
        itemId: 'rack',
        mime: 'image/jpeg',
        data: b64(jpeg()),
        userId: USER,
      }),
    ).toMatchObject({ ok: false, message: /No such visit/ });
    const r = await addPhoto(w.db, {
      orgId: ORG,
      runId: w.runId,
      itemId: 'rack',
      mime: 'image/jpeg',
      data: b64(jpeg()),
      userId: USER,
    });
    const photoId = (r as { value: { id: string } }).value.id;
    expect(await getPhoto(w.db, { orgId: OTHER_ORG, runId: w.runId, photoId })).toMatchObject({
      ok: false,
    });
    expect(await removePhoto(w.db, { orgId: OTHER_ORG, runId: w.runId, photoId })).toMatchObject({
      ok: false,
    });
  });

  it('removes a photo from a draft, but a signed visit keeps and refuses photos', async () => {
    const w = await world();
    const r = await addPhoto(w.db, {
      orgId: ORG,
      runId: w.runId,
      itemId: 'rack',
      mime: 'image/jpeg',
      data: b64(jpeg()),
      userId: USER,
    });
    const photoId = (r as { value: { id: string } }).value.id;
    expect((await removePhoto(w.db, { orgId: ORG, runId: w.runId, photoId })).ok).toBe(true);
    expect(await listPhotos(w.db, ORG, w.runId)).toHaveLength(0);

    const s = await signedRun();
    const kept = (await listPhotos(s.db, ORG, s.runId))[0]!;
    expect(await removePhoto(s.db, { orgId: ORG, runId: s.runId, photoId: kept.id })).toMatchObject(
      {
        ok: false,
        message: /keeps its photos/,
      },
    );
    expect(
      await addPhoto(s.db, {
        orgId: ORG,
        runId: s.runId,
        itemId: 'rack',
        mime: 'image/jpeg',
        data: b64(jpeg()),
        userId: USER,
      }),
    ).toMatchObject({ ok: false, message: /cannot take more photos/ });
  });

  it('does not make photo items something that must be answered before signing', async () => {
    const w = await world();
    await saveRun(w.db, {
      orgId: ORG,
      runId: w.runId,
      results: [
        { itemId: 'picture', label: 'Picture is clear', type: 'passfail', result: 'pass' },
        { itemId: 'rack', label: 'Photo of the rack', type: 'photo', result: null },
        { itemId: 'notes', label: 'Notes', type: 'text', result: null },
      ],
    });
    expect((await sign(w, w.runId)).ok).toBe(true);
  });
});

describe('correcting a signed visit', () => {
  it('leaves the original alone and opens a linked draft with the answers and photos copied', async () => {
    const w = await signedRun();
    const original = { ...w.pmRun.rows[0]! };
    const r = await correctRun(
      w.db,
      { orgId: ORG, runId: w.runId, userId: USER, reason: 'Picture was actually fuzzy' },
      NOW,
    );
    expect(r.ok).toBe(true);
    const id = (r as { value: { id: string; existing: boolean } }).value;
    expect(id.existing).toBe(false);

    const fix = w.pmRun.rows.find((x) => x.id === id.id)!;
    expect(fix).toMatchObject({
      status: 'draft',
      correctsRunId: w.runId,
      correctionReason: 'Picture was actually fuzzy',
      scheduleId: null,
      dueOn: null,
      notes: 'All fine',
    });
    expect(
      (fix.results as { itemId: string; result: unknown }[]).find((x) => x.itemId === 'picture')
        ?.result,
    ).toBe('pass');
    expect(await listPhotos(w.db, ORG, id.id)).toHaveLength(1);
    // The original is exactly as it was signed.
    expect(w.pmRun.rows.find((x) => x.id === w.runId)).toEqual(original);
    expect(await listPhotos(w.db, ORG, w.runId)).toHaveLength(1);
  });

  it('refuses a draft, a missing reason, an unknown visit and another organisation', async () => {
    const w = await world();
    expect(
      await correctRun(w.db, { orgId: ORG, runId: w.runId, userId: USER, reason: 'A real reason' }),
    ).toMatchObject({
      ok: false,
      message: /Only a signed visit/,
    });
    const s = await signedRun();
    expect(
      await correctRun(s.db, { orgId: ORG, runId: s.runId, userId: USER, reason: 'no' }),
    ).toMatchObject({
      ok: false,
      message: /at least 5/,
    });
    expect(
      await correctRun(s.db, { orgId: ORG, runId: s.runId, userId: USER, reason: 'x'.repeat(501) }),
    ).toMatchObject({ ok: false });
    expect(
      await correctRun(s.db, {
        orgId: OTHER_ORG,
        runId: s.runId,
        userId: USER,
        reason: 'A real reason',
      }),
    ).toMatchObject({
      ok: false,
      message: /No such visit/,
    });
  });

  it('returns the open correction instead of making a second one', async () => {
    const w = await signedRun();
    const a = await correctRun(
      w.db,
      { orgId: ORG, runId: w.runId, userId: USER, reason: 'First reason' },
      NOW,
    );
    const b = await correctRun(
      w.db,
      { orgId: ORG, runId: w.runId, userId: USER, reason: 'Second reason' },
      NOW,
    );
    expect(a.ok && b.ok && a.value.id === b.value.id && b.value.existing).toBe(true);
    expect(await correctionsOf(w.db, ORG, w.runId)).toHaveLength(1);
  });

  it('keeps answers only for items still on the checklist and starts new ones empty', async () => {
    const w = await signedRun();
    // The checklist gained an item after the visit was signed.
    (w.db.pmTemplate as unknown as ReturnType<typeof table>).rows[0]!.items = [
      ...items,
      { id: 'cables', label: 'Cables tidy', type: 'passfail' },
    ];
    const r = await correctRun(
      w.db,
      { orgId: ORG, runId: w.runId, userId: USER, reason: 'Missed a check' },
      NOW,
    );
    const fix = w.pmRun.rows.find((x) => x.id === (r as { value: { id: string } }).value.id)!;
    const results = fix.results as { itemId: string; result: unknown }[];
    expect(results.map((x) => x.itemId)).toEqual(['picture', 'rack', 'notes', 'cables']);
    expect(results.find((x) => x.itemId === 'cables')?.result).toBeNull();
  });

  it('can be edited, signed, and moves neither the schedule nor the device history twice', async () => {
    const w = await signedRun();
    const due = (w.pmSchedule.rows[0]!.nextDueOn as Date).getTime();
    const events = w.deviceEvent.rows.length;
    const r = await correctRun(
      w.db,
      { orgId: ORG, runId: w.runId, userId: USER, reason: 'Wrong answer' },
      NOW,
    );
    const fixId = (r as { value: { id: string } }).value.id;
    await saveRun(w.db, {
      orgId: ORG,
      runId: fixId,
      results: [
        { itemId: 'picture', label: 'Picture is clear', type: 'passfail', result: 'fail' },
        { itemId: 'rack', label: 'Photo of the rack', type: 'photo', result: null },
        { itemId: 'notes', label: 'Notes', type: 'text', result: null },
      ],
    });
    const signed = await sign(w, fixId, 'Pat Lead');
    expect(signed).toMatchObject({ ok: true, value: { failed: 1 } });
    expect(w.pmRun.rows.find((x) => x.id === fixId)).toMatchObject({
      status: 'signed',
      signedByName: 'Pat Lead',
    });
    expect((w.pmSchedule.rows[0]!.nextDueOn as Date).getTime()).toBe(due);
    expect(w.deviceEvent.rows.length).toBe(events);
    // The original still says what it said.
    expect(w.pmRun.rows.find((x) => x.id === w.runId)).toMatchObject({
      failedCount: 0,
      signedByName: 'Sam Tech',
    });
  });
});

describe('reports', () => {
  it('list the photos by hash, link a correction, and count the correction instead of the original', async () => {
    const w = await signedRun();
    const r = await correctRun(
      w.db,
      { orgId: ORG, runId: w.runId, userId: USER, reason: 'Wrong answer' },
      NOW,
    );
    const fixId = (r as { value: { id: string } }).value.id;
    await saveRun(w.db, {
      orgId: ORG,
      runId: fixId,
      results: [
        { itemId: 'picture', label: 'Picture is clear', type: 'passfail', result: 'fail' },
        { itemId: 'rack', label: 'Photo of the rack', type: 'photo', result: null },
        { itemId: 'notes', label: 'Notes', type: 'text', result: null },
      ],
    });
    await sign(w, fixId);

    const key = generateKeyPair();
    const rep = await issuePmReport(
      w.db,
      {
        orgId: ORG,
        from: new Date('2026-10-01T00:00:00Z'),
        to: new Date('2026-10-31T00:00:00Z'),
        userId: USER,
      },
      { ...key, keyId: 'k1' },
      NOW,
    );
    expect(rep.ok).toBe(true);
    const payload = (
      (w.db.registerIssue as unknown as ReturnType<typeof table>).rows[0]!.payload as {
        payload: {
          summary: { visits: number; itemsFailed: number };
          runs: {
            id: string;
            photos?: { sha256: string }[];
            corrects?: string;
            supersededBy?: string;
          }[];
        };
      }
    ).payload;
    expect(payload.runs).toHaveLength(2);
    const orig = payload.runs.find((x) => x.id === w.runId)!;
    const fix = payload.runs.find((x) => x.id === fixId)!;
    expect(orig.supersededBy).toBe(fixId);
    expect(fix.corrects).toBe(w.runId);
    expect(orig.photos?.[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fix.photos?.[0]?.sha256).toBe(orig.photos?.[0]?.sha256);
    expect(payload.summary).toMatchObject({ visits: 1, itemsFailed: 1 });
  });
});
