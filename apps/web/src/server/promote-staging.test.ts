import { describe, expect, it } from 'vitest';
import { RoomModel, type Device } from '@kestrel/model';
import { PromoteError, promoteStaging, type PromoteDb } from './promote-staging';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222221';
const STAGING = '33333333-3333-4333-8333-333333333331';
const LIVE = '33333333-3333-4333-8333-333333333332';

const device = (id: string): Device => ({
  id,
  name: id,
  category: 'projector',
  ports: [],
  extraCapabilities: [],
  control: { kind: 'generic', protocol: 'pjlink' },
  settings: {},
});
const model = (...ids: string[]) => RoomModel.parse({ roomType: 'meeting', devices: ids.map(device) });

function world(over: { live?: RoomModel | null } = {}) {
  const room = table([
    { id: STAGING, orgId: ORG, siteId: SITE, type: 'meeting', kind: 'staging', name: 'Boardroom (staging)' },
    { id: LIVE, orgId: ORG, siteId: SITE, type: 'meeting', kind: 'standard', name: 'Boardroom' },
  ]);
  const live = over.live === undefined ? model('a') : over.live;
  const roomDraft = table(live ? [{ id: 'd1', orgId: ORG, roomId: LIVE, revision: 4, model: live }] : []);
  const roomDraftVersion = table([]);
  const db = { room, roomDraft, roomDraftVersion } as unknown as PromoteDb;
  const input = (m = model('a', 'b'), o = {}) => ({ orgId: ORG, stagingId: STAGING, targetId: LIVE, model: m, userId: 'u1', ...o });
  return { db, room, roomDraft, roomDraftVersion, input };
}

describe('promoting a staging room', () => {
  it('puts the staging design in the live draft and keeps the old one as a version', async () => {
    const w = world();
    expect(await promoteStaging(w.db, w.input())).toEqual({ changed: true, revision: 5 });
    expect((w.roomDraft.rows[0]!.model as RoomModel).devices.map((d) => d.id)).toEqual(['a', 'b']);
    expect(w.roomDraftVersion.rows).toHaveLength(1);
    expect(w.roomDraftVersion.rows[0]).toMatchObject({
      draftId: 'd1',
      revision: 4,
      label: 'Before promoting “Boardroom (staging)”',
    });
    expect((w.roomDraftVersion.rows[0]!.model as RoomModel).devices).toHaveLength(1);
  });

  it('does nothing when the live design already matches', async () => {
    const w = world({ live: model('a', 'b') });
    expect(await promoteStaging(w.db, w.input())).toEqual({ changed: false });
    expect(w.roomDraftVersion.rows).toHaveLength(0);
  });

  it('gives a live room with no design the staging one', async () => {
    const w = world({ live: null });
    expect(await promoteStaging(w.db, w.input())).toEqual({ changed: true, revision: 1 });
    expect(w.roomDraft.rows).toHaveLength(1);
  });

  it('only promotes a staging room, into an ordinary room at the same site and of the same type', async () => {
    const w = world();
    await expect(promoteStaging(w.db, w.input(model('a'), { stagingId: LIVE }))).rejects.toThrow(/not a staging room/);
    const live = w.room.rows.find((r) => r.id === LIVE)!;
    live.kind = 'combined';
    await expect(promoteStaging(w.db, w.input())).rejects.toThrow(/ordinary room/);
    live.kind = 'standard';
    live.siteId = 'other';
    await expect(promoteStaging(w.db, w.input())).rejects.toThrow(/same site/);
    live.siteId = SITE;
    live.type = 'training';
    await expect(promoteStaging(w.db, w.input())).rejects.toThrow(/same type/);
    await expect(promoteStaging(w.db, w.input(model('a'), { targetId: 'nope' }))).rejects.toThrow(PromoteError);
  });

  it('does not overwrite a save made in between', async () => {
    const w = world();
    const find = w.roomDraft.findFirst;
    w.roomDraft.findFirst = async (a) => {
      const row = await find(a);
      const seen = row && { ...row };
      if (row) row.revision = 5;
      return seen;
    };
    await expect(promoteStaging(w.db, w.input())).rejects.toThrow(/changed while promoting/);
  });
});
