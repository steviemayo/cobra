import { describe, expect, it } from 'vitest';
import { RoomModel, STARTER_TEMPLATES } from '@kestrel/model';
import {
  deleteGroup,
  groupProblems,
  loadGroup,
  saveGroup,
  syncCombinedRooms,
  type GroupDb,
} from './room-groups';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '11111111-1111-4111-8111-111111111112';
const SITE = '22222222-2222-4222-8222-222222222221';
const SITE2 = '22222222-2222-4222-8222-222222222222';
const GW = '99999999-9999-4999-8999-999999999991';
const GW2 = '99999999-9999-4999-8999-999999999992';
const [A, B, C, D, L, FAR, THEIRS, OTHER_GW, LOOSE] = Array.from(
  { length: 9 },
  (_, i) => `33333333-3333-4333-8333-33333333333${i + 1}`,
);

const meeting = () => structuredClone(STARTER_TEMPLATES[0]!.model);

function world({ drafts = [A!, B!, C!, D!, L!] }: { drafts?: string[] } = {}) {
  let n = 0;
  const at = (i: number) => new Date(2026, 0, 1, 0, 0, i);
  const room = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    orgId: ORG,
    name,
    type: 'meeting',
    siteId: SITE,
    gatewayId: GW,
    groupId: null,
    kind: 'standard',
    memberRoomIds: [],
    createdAt: at(n++),
    ...extra,
  });
  const rooms = table([
    room(A!, 'Room A'),
    room(B!, 'Room B'),
    room(C!, 'Room C'),
    room(D!, 'Room D'),
    room(L!, 'Large'),
    room(FAR!, 'Far', { siteId: SITE2 }),
    room(THEIRS!, 'Theirs', { orgId: OTHER }),
    room(OTHER_GW!, 'Elsewhere', { gatewayId: GW2 }),
    room(LOOSE!, 'Loose', { gatewayId: null }),
  ]);
  const roomGroup = table([]);
  const roomDivider = table([]);
  const roomDraft = table(
    drafts.map((roomId) => ({ id: `d-${roomId}`, orgId: ORG, roomId, model: meeting() })),
  );
  const release = table([]);
  let seq = 0;
  // The in-memory tables do not invent ids; give new rows one.
  for (const t of [rooms, roomGroup, roomDivider, roomDraft]) {
    const create = t.create;
    t.create = async (args: { data: Record<string, unknown> }) =>
      create({
        data: {
          id: `gen-${++seq}`,
          createdAt: new Date(2026, 0, 2, 0, 0, seq),
          ...args.data,
        },
      });
  }
  return {
    db: { room: rooms, roomGroup, roomDivider, roomDraft, release } as unknown as GroupDb,
    rooms,
    roomGroup,
    roomDivider,
    roomDraft,
    release,
  };
}

const line = (ids: string[]) => ({
  name: 'Wing',
  siteId: SITE,
  roomIds: ids,
  dividers: ids.slice(1).map((r, i) => ({ name: `Wall ${i + 1}`, roomIds: [ids[i]!, r] })),
});

describe('checking a group', () => {
  it('accepts rooms at one site on one gateway', async () => {
    expect(await groupProblems(world().db, ORG, line([A!, B!, C!]))).toEqual([]);
  });

  it('refuses rooms at another site, on another gateway, or from another organisation', async () => {
    const w = world();
    expect((await groupProblems(w.db, ORG, line([A!, FAR!]))).join()).toMatch(/different site/);
    expect((await groupProblems(w.db, ORG, line([A!, OTHER_GW!]))).join()).toMatch(/same gateway/);
    expect((await groupProblems(w.db, ORG, line([A!, THEIRS!]))).join()).toMatch(/not found/);
  });

  it('two rooms with no gateway yet are fine; one with and one without is not', async () => {
    const w = world();
    expect(await groupProblems(w.db, ORG, line([LOOSE!, LOOSE!]))).not.toEqual([]); // twice
    expect((await groupProblems(w.db, ORG, line([A!, LOOSE!]))).join()).toMatch(/same gateway/);
  });

  it('refuses a room that is in another group', async () => {
    const w = world();
    await saveGroup(w.db, ORG, line([A!, B!]));
    const problems = await groupProblems(w.db, ORG, line([B!, C!]));
    expect(problems.join()).toMatch(/already in another room group/);
  });

  it('refuses a combined room as a member', async () => {
    const w = world();
    w.rooms.rows.push({
      id: 'cmb',
      orgId: ORG,
      name: 'A + B',
      siteId: SITE,
      gatewayId: GW,
      groupId: null,
      kind: 'combined',
      memberRoomIds: [A, B],
      type: 'meeting',
    });
    expect((await groupProblems(w.db, ORG, line(['cmb', C!]))).join()).toMatch(/combined room/);
  });
});

describe('saving a group', () => {
  it('stores the group, its dividers, and puts the rooms in it', async () => {
    const w = world();
    const id = await saveGroup(w.db, ORG, line([A!, B!, C!]));
    expect(w.roomGroup.rows).toHaveLength(1);
    expect(w.roomDivider.rows).toHaveLength(2);
    expect(w.rooms.rows.filter((r) => r.groupId === id).map((r) => r.id)).toEqual([A, B, C]);
  });

  it('stores what each wall does when it opens and closes, with defaults, and keeps it when edited', async () => {
    const w = world();
    const id = await saveGroup(w.db, ORG, {
      ...line([A!, B!, C!]),
      dividers: [
        { name: 'Wall 1', roomIds: [A!, B!], onOpen: 'on', onClose: 'restore' },
        { name: 'Wall 2', roomIds: [B!, C!] },
      ],
    });
    expect(w.roomDivider.rows.map((d) => [d.onOpen, d.onClose])).toEqual([
      ['on', 'restore'],
      ['follow', 'off'],
    ]);
    const [first, second] = w.roomDivider.rows;
    // Saving again without saying keeps what was set; saying changes it.
    await saveGroup(w.db, ORG, {
      groupId: id,
      name: 'Wing',
      siteId: SITE,
      roomIds: [A!, B!, C!],
      dividers: [
        { id: first!.id as string, name: 'Wall 1', roomIds: [A!, B!] },
        { id: second!.id as string, name: 'Wall 2', roomIds: [B!, C!], onClose: 'follow' },
      ],
    });
    const view = await loadGroup(w.db, ORG, id);
    expect(view!.dividers.map((d) => [d.onOpen, d.onClose, d.open])).toEqual([
      ['on', 'restore', false],
      ['follow', 'follow', false],
    ]);
  });

  it('keeps a divider id when it is edited, and drops removed dividers and rooms', async () => {
    const w = world();
    const id = await saveGroup(w.db, ORG, line([A!, B!, C!]));
    const first = w.roomDivider.rows[0]!;
    await saveGroup(w.db, ORG, {
      groupId: id,
      name: 'Wing',
      siteId: SITE,
      roomIds: [A!, B!],
      dividers: [{ id: first.id as string, name: 'Renamed', roomIds: [A!, B!] }],
    });
    expect(w.roomDivider.rows).toHaveLength(1);
    expect(w.roomDivider.rows[0]).toMatchObject({ id: first.id, name: 'Renamed' });
    expect(w.rooms.rows.find((r) => r.id === C)!.groupId).toBeNull();
  });

  it('refuses a broken layout without changing anything', async () => {
    const w = world();
    await expect(
      saveGroup(w.db, ORG, {
        name: 'Bad',
        siteId: SITE,
        roomIds: [A!, B!],
        dividers: [{ name: 'Wall', roomIds: [A!, C!] }],
      }),
    ).rejects.toThrow(/not in this group/);
    expect(w.roomGroup.rows).toHaveLength(0);
  });
});

describe('what a group implies', () => {
  it('a line of three: three combined rooms, none created yet', async () => {
    const w = world();
    const id = await saveGroup(w.db, ORG, line([A!, B!, C!]));
    const view = (await loadGroup(w.db, ORG, id))!;
    expect(view.combined.map((c) => c.name)).toEqual([
      'Room A + Room B',
      'Room B + Room C',
      'Room A + Room B + Room C',
    ]);
    expect(view.combined.every((c) => c.roomId === null)).toBe(true);
  });

  it('is not visible to another organisation', async () => {
    const w = world();
    const id = await saveGroup(w.db, ORG, line([A!, B!]));
    expect(await loadGroup(w.db, OTHER, id)).toBeNull();
  });
});

describe('creating the combined rooms', () => {
  it('creates each one as a combined room with a derived draft, on the same gateway', async () => {
    const w = world();
    const id = await saveGroup(w.db, ORG, line([A!, B!, C!]));
    const res = await syncCombinedRooms(w.db, ORG, id);
    expect(res.created).toHaveLength(3);

    const combined = w.rooms.rows.filter((r) => r.kind === 'combined');
    expect(combined).toHaveLength(3);
    for (const r of combined) expect(r).toMatchObject({ gatewayId: GW, siteId: SITE, groupId: id });
    const abc = combined.find((r) => (r.memberRoomIds as string[]).length === 3)!;
    const draft = w.roomDraft.rows.find((d) => d.roomId === abc.id)!;
    const model = RoomModel.parse(draft.model);
    expect(model.devices.length).toBe(meeting().devices.length * 3);
    const present = model.activities.find((a) => a.kind === 'present')!;
    expect(present.sources).toHaveLength(6);
  });

  it('is safe to run again: creates nothing new', async () => {
    const w = world();
    const id = await saveGroup(w.db, ORG, line([A!, B!]));
    await syncCombinedRooms(w.db, ORG, id);
    const again = await syncCombinedRooms(w.db, ORG, id);
    expect(again).toEqual({ created: [], skipped: [], removed: [], kept: [] });
    expect(w.rooms.rows.filter((r) => r.kind === 'combined')).toHaveLength(1);
  });

  it('skips a combined room when a member has no design yet, and says which', async () => {
    const w = world({ drafts: [A!] });
    const id = await saveGroup(w.db, ORG, line([A!, B!]));
    const res = await syncCombinedRooms(w.db, ORG, id);
    expect(res.created).toEqual([]);
    expect(res.skipped[0]!.reason).toMatch(/Room B.*no design/);
  });

  it('a wall that opens a big room onto two rooms only makes the combinations that wall allows', async () => {
    const w = world();
    const id = await saveGroup(w.db, ORG, {
      name: 'Wing',
      siteId: SITE,
      roomIds: [A!, B!, C!, D!, L!],
      dividers: [
        { name: 'A-B', roomIds: [A!, B!] },
        { name: 'B-C', roomIds: [B!, C!] },
        { name: 'C-D', roomIds: [C!, D!] },
        { name: 'L opens on B and C', roomIds: [L!, B!, C!] },
      ],
    });
    const view = (await loadGroup(w.db, ORG, id))!;
    const names = view.combined.map((c) => c.name);
    expect(names).toContain('Room B + Room C + Large');
    expect(names).not.toContain('Room B + Large');
    expect(names).toContain('Room A + Room B + Room C + Room D + Large');
  });

  it('removes combined rooms the dividers no longer allow, unless they were deployed', async () => {
    const w = world();
    const id = await saveGroup(w.db, ORG, line([A!, B!, C!]));
    await syncCombinedRooms(w.db, ORG, id);
    const bc = w.rooms.rows.find((r) => r.name === 'Room B + Room C')!;
    const ab = w.rooms.rows.find((r) => r.name === 'Room A + Room B')!;
    w.release.rows.push({ id: 'rel', roomId: ab.id });

    // Take room C and the B-C wall out: only A + B is still possible.
    const dividers = w.roomDivider.rows.filter((d) => d.name === 'Wall 1');
    await saveGroup(w.db, ORG, {
      groupId: id,
      name: 'Wing',
      siteId: SITE,
      roomIds: [A!, B!],
      dividers: dividers.map((d) => ({
        id: d.id as string,
        name: d.name as string,
        roomIds: d.roomIds as string[],
      })),
    });
    const res = await syncCombinedRooms(w.db, ORG, id);
    expect(res.removed.sort()).toEqual(['Room A + Room B + Room C', 'Room B + Room C']);
    expect(w.rooms.rows.some((r) => r.id === bc.id)).toBe(false);
    expect(w.rooms.rows.some((r) => r.id === ab.id)).toBe(true);
  });

  it('never deletes a deployed combined room by itself', async () => {
    const w = world();
    const id = await saveGroup(w.db, ORG, line([A!, B!, C!]));
    await syncCombinedRooms(w.db, ORG, id);
    const bc = w.rooms.rows.find((r) => r.name === 'Room B + Room C')!;
    w.release.rows.push({ id: 'rel', roomId: bc.id });
    const first = w.roomDivider.rows.find((d) => d.name === 'Wall 1')!;
    await saveGroup(w.db, ORG, {
      groupId: id,
      name: 'Wing',
      siteId: SITE,
      roomIds: [A!, B!],
      dividers: [{ id: first.id as string, name: 'Wall 1', roomIds: [A!, B!] }],
    });
    const res = await syncCombinedRooms(w.db, ORG, id);
    expect(res.kept).toEqual(['Room B + Room C']);
    expect(w.rooms.rows.some((r) => r.id === bc.id)).toBe(true);
  });
});

describe('deleting a group', () => {
  it('removes the group and its combined rooms, and frees the ordinary rooms', async () => {
    const w = world();
    const id = await saveGroup(w.db, ORG, line([A!, B!]));
    await syncCombinedRooms(w.db, ORG, id);
    const res = await deleteGroup(w.db, ORG, id);
    expect(res).toEqual({ deleted: true, deployed: [] });
    expect(w.roomGroup.rows).toHaveLength(0);
    expect(w.rooms.rows.some((r) => r.kind === 'combined')).toBe(false);
    expect(w.rooms.rows.find((r) => r.id === A)!.groupId).toBeNull();
  });

  it('refuses while a combined room has been deployed, and names it', async () => {
    const w = world();
    const id = await saveGroup(w.db, ORG, line([A!, B!]));
    await syncCombinedRooms(w.db, ORG, id);
    const combined = w.rooms.rows.find((r) => r.kind === 'combined')!;
    w.release.rows.push({ id: 'rel', roomId: combined.id });
    expect(await deleteGroup(w.db, ORG, id)).toEqual({
      deleted: false,
      deployed: ['Room A + Room B'],
    });
    expect(w.roomGroup.rows).toHaveLength(1);
  });
});
