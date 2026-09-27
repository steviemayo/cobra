import { describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, RoomModel } from '@kestrel/model';
import {
  CommissioningError,
  MAX_ITEMS,
  checklistFor,
  getRun,
  listRuns,
  progress,
  setResult,
  signOff,
  startRun,
  type CommissioningDb,
} from './commissioning';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const ROOM = '33333333-3333-4333-8333-333333333331';
const user = { id: 'u1', email: 'tech@example.com' };
const meeting = () => structuredClone(STARTER_TEMPLATES[0]!.model) as RoomModel;

function world() {
  const commissioningRun = table([]);
  let n = 0;
  const create = commissioningRun.create;
  commissioningRun.create = async (a: { data: Record<string, unknown> }) =>
    create({ data: { status: 'in_progress', startedAt: new Date(2026, 8, 27, 10, 0, n++), signedOffAt: null, notes: null, ...a.data } });
  return { db: { commissioningRun } as unknown as CommissioningDb, commissioningRun };
}
const start = (db: CommissioningDb, model = meeting()) =>
  startRun(db, { orgId: ORG, roomId: ROOM, model, releaseNumber: 3, user });

describe('the checklist for a room', () => {
  const items = checklistFor(meeting());
  const by = (g: string) => items.filter((i) => i.group === g);

  it('covers what people do, screens, sound and the room itself, all starting unanswered', () => {
    // The starter room has no camera, so there is no Cameras group.
    expect(new Set(items.map((i) => i.group))).toEqual(new Set(['What people do', 'Screens', 'Sound', 'Room']));
    expect(items.every((i) => i.result === 'pending')).toBe(true);
  });

  it('has a check for each way of using the room, per source', () => {
    const model = meeting();
    const present = model.activities.find((a) => a.kind === 'present' && a.sources.length > 1);
    if (present) expect(by('What people do').filter((i) => i.id.startsWith(`activity:${present.id}:`))).toHaveLength(present.sources.length);
    expect(by('What people do').some((i) => /turns everything off/.test(i.label))).toBe(true);
  });

  it('has a check for each screen, camera and microphone in the design', () => {
    const model = meeting();
    for (const d of model.devices) {
      if (['display', 'projector'].includes(d.category)) expect(items.some((i) => i.id === `display:${d.id}`)).toBe(true);
      if (['reinforcement_mic', 'voice_capture_mic'].includes(d.category)) expect(items.some((i) => i.id === `mic:${d.id}`)).toBe(true);
      if (['conf_camera', 'fixed_camera', 'ptz_camera', 'autoframing_camera'].includes(d.category))
        expect(items.some((i) => i.id === `camera:${d.id}`)).toBe(true);
    }
  });

  it('always ends by checking devices are online and the panel works', () => {
    expect(items.slice(-2).map((i) => i.id)).toEqual(['room:online', 'room:panel']);
  });

  it('gives every item a unique, stable id, and stays a sensible size', () => {
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(items.map((i) => i.id)).toEqual(checklistFor(meeting()).map((i) => i.id));
    expect(items.length).toBeLessThanOrEqual(MAX_ITEMS);
  });

  it('leaves out hidden activities', () => {
    const model = meeting();
    const hidden = model.activities.find((a) => a.kind !== 'room_off')!;
    hidden.hidden = true;
    expect(checklistFor(model).some((i) => i.id.startsWith(`activity:${hidden.id}`))).toBe(false);
  });

  it('adds checks for cameras that move and for environment devices, only when the room has them', () => {
    const model = meeting();
    model.devices.push(
      { id: 'ptz', name: 'Front camera', category: 'ptz_camera', ports: [], extraCapabilities: [], settings: {} } as never,
      { id: 'blinds1', name: 'Window blinds', category: 'blinds', ports: [], extraCapabilities: [], settings: {} } as never,
    );
    const more = checklistFor(model);
    expect(more.some((i) => i.id === 'camera:ptz:move')).toBe(true);
    expect(more.some((i) => i.id === 'env:blinds1' && i.label === 'Window blinds works from the panel')).toBe(true);
    expect(items.some((i) => i.id === 'camera:ptz:move')).toBe(false);
  });
});

describe('a walk-through', () => {
  it('starts with the checklist, who started it and the release under test', async () => {
    const w = world();
    const run = await start(w.db);
    expect(run).toMatchObject({ status: 'in_progress', releaseNumber: 3, startedByEmail: 'tech@example.com', signedOffAt: null });
    expect(run.items.length).toBeGreaterThan(5);
    expect(await getRun(w.db, ORG, run.id)).toMatchObject({ id: run.id });
    expect(await getRun(w.db, 'other-org', run.id)).toBeNull();
  });

  it('allows only one under way for a room, and another after sign-off', async () => {
    const w = world();
    const run = await start(w.db);
    await expect(start(w.db)).rejects.toThrow(/already under way/);
    for (const i of run.items) await setResult(w.db, { orgId: ORG, runId: run.id, itemId: i.id, result: 'pass' });
    await signOff(w.db, { orgId: ORG, runId: run.id, user });
    await expect(start(w.db)).resolves.toBeDefined();
  });

  it('records results and notes, and a note goes when the item is marked pass again', async () => {
    const w = world();
    const run = await start(w.db);
    const id = run.items[0]!.id;
    let r = await setResult(w.db, { orgId: ORG, runId: run.id, itemId: id, result: 'fail', note: '  no sound  ' });
    expect(r.items[0]).toMatchObject({ result: 'fail', note: 'no sound' });
    r = await setResult(w.db, { orgId: ORG, runId: run.id, itemId: id, result: 'pass' });
    expect(r.items[0]!.result).toBe('pass');
    expect(r.items[0]!.note).toBeUndefined();
    expect(progress(r.items)).toMatchObject({ pass: 1, pending: r.items.length - 1 });
  });

  it('refuses an item that is not in the check, or a check that is not there', async () => {
    const w = world();
    const run = await start(w.db);
    await expect(setResult(w.db, { orgId: ORG, runId: run.id, itemId: 'nope', result: 'pass' })).rejects.toThrow(/not in this check/);
    await expect(setResult(w.db, { orgId: ORG, runId: 'nope', itemId: 'x', result: 'pass' })).rejects.toThrow(CommissioningError);
    await expect(setResult(w.db, { orgId: 'other-org', runId: run.id, itemId: run.items[0]!.id, result: 'pass' })).rejects.toThrow(CommissioningError);
  });

  it('will not sign off until everything has an answer', async () => {
    const w = world();
    const run = await start(w.db);
    await setResult(w.db, { orgId: ORG, runId: run.id, itemId: run.items[0]!.id, result: 'pass' });
    await expect(signOff(w.db, { orgId: ORG, runId: run.id, user })).rejects.toThrow(/still need an answer/);
  });

  it('will not sign off a failure with no note, but will with one', async () => {
    const w = world();
    const run = await start(w.db);
    for (const [n, i] of run.items.entries())
      await setResult(w.db, { orgId: ORG, runId: run.id, itemId: i.id, result: n === 0 ? 'fail' : 'skip' });
    await expect(signOff(w.db, { orgId: ORG, runId: run.id, user })).rejects.toThrow(/Say what was wrong/);
    await setResult(w.db, { orgId: ORG, runId: run.id, itemId: run.items[0]!.id, result: 'fail', note: 'Left speaker silent' });
    const done = await signOff(w.db, { orgId: ORG, runId: run.id, notes: ' Retest Friday ', user }, new Date('2026-09-27T12:00:00Z'));
    expect(done).toMatchObject({ status: 'signed_off', signedOffByEmail: 'tech@example.com', notes: 'Retest Friday' });
    expect(done.signedOffAt).toEqual(new Date('2026-09-27T12:00:00Z'));
  });

  it('never changes once signed off', async () => {
    const w = world();
    const run = await start(w.db);
    for (const i of run.items) await setResult(w.db, { orgId: ORG, runId: run.id, itemId: i.id, result: 'pass' });
    await signOff(w.db, { orgId: ORG, runId: run.id, user });
    await expect(setResult(w.db, { orgId: ORG, runId: run.id, itemId: run.items[0]!.id, result: 'fail', note: 'x' })).rejects.toThrow(/signed off/);
    await expect(signOff(w.db, { orgId: ORG, runId: run.id, user })).rejects.toThrow(/already been signed off/);
  });

  it('lists a room’s checks, newest first', async () => {
    const w = world();
    const first = await start(w.db);
    for (const i of first.items) await setResult(w.db, { orgId: ORG, runId: first.id, itemId: i.id, result: 'pass' });
    await signOff(w.db, { orgId: ORG, runId: first.id, user });
    const second = await start(w.db);
    expect((await listRuns(w.db, ORG, ROOM)).map((r) => r.id)).toEqual([second.id, first.id]);
    expect(await listRuns(w.db, ORG, 'other-room')).toEqual([]);
  });
});
