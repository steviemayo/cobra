import { describe, expect, it } from 'vitest';
import { generateKeyPair, signManifest } from '@kestrel/crypto';
import { RoomModel, applyBindings, type Device } from '@kestrel/model';
import { effectivePanel, readPanel } from './panel-settings';
import { ReleaseRestoreError, restoreReleaseDesign, type ReleaseRestoreDb } from './release-restore';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const ROOM = '33333333-3333-4333-8333-333333333331';
const pair = generateKeyPair();
const key = { keyId: 'k1', privateKeyPem: pair.privateKeyPem, publicKeyPem: pair.publicKeyPem };

const device = (id: string, settings: Record<string, unknown> = {}): Device => ({
  id,
  name: id,
  category: 'projector',
  ports: [],
  extraCapabilities: [],
  control: { kind: 'generic', protocol: 'pjlink' },
  settings,
});
const modelWith = (...ids: string[]) =>
  RoomModel.parse({ roomType: 'meeting', devices: ids.map((i) => device(i)) });

const release = (number: number, model: RoomModel) => {
  const id = `44444444-4444-4444-8444-44444444444${number}`;
  const signed = signManifest(
    {
      manifestVersion: 1,
      orgId: ORG,
      roomId: ROOM,
      roomName: 'Boardroom',
      releaseId: id,
      releaseNumber: number,
      createdAt: new Date().toISOString(),
      model,
      drivers: {},
      panel: effectivePanel(readPanel(null), { mode: 'dark', language: 'en' }),
    },
    key,
  );
  return { id, orgId: ORG, roomId: ROOM, number, manifest: signed, hash: signed.hash };
};

function world(draftModel: RoomModel) {
  const rel = table([release(1, modelWith('a')), release(2, modelWith('a', 'b'))]);
  const roomDraft = table([{ id: 'd1', orgId: ORG, roomId: ROOM, revision: 5, model: draftModel }]);
  const roomDraftVersion = table([]);
  const db = { release: rel, roomDraft, roomDraftVersion } as unknown as ReleaseRestoreDb;
  const input = (releaseId: string, over = {}) => ({
    orgId: ORG,
    roomId: ROOM,
    roomType: 'meeting',
    releaseId,
    userId: 'u1',
    ...over,
  });
  return { db, roomDraft, roomDraftVersion, rel, input };
}

describe('restoring a release design', () => {
  it('puts the release design in the draft and keeps the old draft as a version', async () => {
    const w = world(modelWith('a', 'b', 'c'));
    const out = await restoreReleaseDesign(w.db, w.input(w.rel.rows[0]!.id as string));
    expect(out).toMatchObject({ changed: true, revision: 6 });
    const draft = w.roomDraft.rows[0]!;
    expect(draft.revision).toBe(6);
    expect((draft.model as RoomModel).devices.map((d) => d.id)).toEqual(['a']);
    expect(w.roomDraftVersion.rows).toHaveLength(1);
    expect(w.roomDraftVersion.rows[0]).toMatchObject({
      draftId: 'd1',
      revision: 5,
      label: 'Before restoring release 1',
    });
    expect((w.roomDraftVersion.rows[0]!.model as RoomModel).devices).toHaveLength(3);
  });

  it('does nothing when the draft already matches', async () => {
    const w = world(modelWith('a'));
    const out = await restoreReleaseDesign(w.db, w.input(w.rel.rows[0]!.id as string));
    expect(out).toEqual({ changed: false });
    expect(w.roomDraftVersion.rows).toHaveLength(0);
    expect(w.roomDraft.rows[0]!.revision).toBe(5);
  });

  it('takes inline addresses and logins out of the design', async () => {
    const withAddress = applyBindings(modelWith('a'), { a: { host: '10.0.0.9', password: 'hunter2' } });
    const w = world(modelWith('z'));
    w.rel.rows.push(release(3, withAddress));
    await restoreReleaseDesign(w.db, w.input(w.rel.rows[2]!.id as string));
    expect(JSON.stringify(w.roomDraft.rows[0]!.model)).not.toContain('10.0.0.9');
    expect(JSON.stringify(w.roomDraft.rows[0]!.model)).not.toContain('hunter2');
  });

  it('refuses a release of another room, a different type, or a room with no design', async () => {
    const w = world(modelWith('z'));
    await expect(restoreReleaseDesign(w.db, w.input('nope'))).rejects.toThrow(/not found/);
    await expect(
      restoreReleaseDesign(w.db, w.input(w.rel.rows[0]!.id as string, { roomType: 'training' })),
    ).rejects.toThrow(/different room type/);
    w.roomDraft.rows.length = 0;
    await expect(restoreReleaseDesign(w.db, w.input(w.rel.rows[0]!.id as string))).rejects.toThrow(
      ReleaseRestoreError,
    );
  });

  it('does not overwrite a save made in between', async () => {
    const w = world(modelWith('z'));
    // Someone saves after the draft was read but before it is updated.
    const find = w.roomDraft.findFirst;
    w.roomDraft.findFirst = async (a) => {
      const row = await find(a);
      const seen = row && { ...row };
      if (row) row.revision = 6;
      return seen;
    };
    await expect(restoreReleaseDesign(w.db, w.input(w.rel.rows[0]!.id as string))).rejects.toThrow(
      /changed while restoring/,
    );
  });
});
