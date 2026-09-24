import { describe, expect, it } from 'vitest';
import {
  combinationProblem,
  combinationsForGateway,
  recordCombined,
  type CombinationDb,
} from './combinations';
import { configVersion } from './gateway-service';
import { queueCombine } from './control-service';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '11111111-1111-4111-8111-111111111112';
const GW = '99999999-9999-4999-8999-999999999991';
const GW2 = '99999999-9999-4999-8999-999999999992';
const SITE = '22222222-2222-4222-8222-222222222221';
const SITE2 = '22222222-2222-4222-8222-222222222222';
const N = '33333333-3333-4333-8333-333333333331';
const S = '33333333-3333-4333-8333-333333333332';
const S2 = '33333333-3333-4333-8333-333333333333';
const ELSEWHERE = '33333333-3333-4333-8333-333333333334';
const LOOSE = '33333333-3333-4333-8333-333333333335';
const OTHER_SITE = '33333333-3333-4333-8333-333333333336';
const OTHERS_ROOM = '33333333-3333-4333-8333-333333333337';
const COMBO = '77777777-7777-4777-8777-777777777771';

function world(combos: Record<string, unknown>[] = []) {
  const room = table([
    { id: N, orgId: ORG, name: 'North', siteId: SITE, gatewayId: GW },
    { id: S, orgId: ORG, name: 'South', siteId: SITE, gatewayId: GW },
    { id: S2, orgId: ORG, name: 'Centre', siteId: SITE, gatewayId: GW },
    { id: ELSEWHERE, orgId: ORG, name: 'Annexe', siteId: SITE, gatewayId: GW2 },
    { id: LOOSE, orgId: ORG, name: 'Loose', siteId: SITE, gatewayId: null },
    { id: OTHER_SITE, orgId: ORG, name: 'Far', siteId: SITE2, gatewayId: GW },
    { id: OTHERS_ROOM, orgId: OTHER, name: 'Theirs', siteId: SITE, gatewayId: GW },
  ]);
  const roomCombination = table(
    combos.map((c) => ({
      orgId: ORG,
      secondaryVideo: 'follow',
      secondaryAudio: 'follow',
      combined: false,
      ...c,
    })),
  );
  const controlIntent = table([]);
  const auditLog = table([]);
  return {
    db: { room, roomCombination, controlIntent, auditLog } as unknown as CombinationDb,
    roomCombination,
    controlIntent,
    auditLog,
  };
}

describe('what can be combined', () => {
  it('accepts rooms at one site on one gateway', async () => {
    const w = world();
    expect(
      await combinationProblem(w.db, ORG, { primaryRoomId: N, secondaryRoomIds: [S, S2] }),
    ).toBeNull();
  });

  it('rejects the wrong shapes, each with a plain reason', async () => {
    const w = world();
    const p = (primaryRoomId: string, secondaryRoomIds: string[]) =>
      combinationProblem(w.db, ORG, { primaryRoomId, secondaryRoomIds });
    expect(await p(N, [])).toContain('at least one');
    expect(await p(N, [N])).toContain('once');
    expect(await p(N, [S, S])).toContain('once');
    expect(await p(N, [OTHERS_ROOM])).toContain('not found');
    expect(await p(N, [LOOSE])).toContain('not assigned to a gateway');
    expect(await p(N, [ELSEWHERE])).toContain('same gateway');
    expect(await p(N, [OTHER_SITE])).toContain('same site');
  });

  it('will not let a room answer to two primaries, but lets a combination be edited', async () => {
    const w = world([{ id: COMBO, name: 'Ballroom', primaryRoomId: N, secondaryRoomIds: [S] }]);
    expect(
      await combinationProblem(w.db, ORG, { primaryRoomId: S2, secondaryRoomIds: [S] }),
    ).toContain('already part of “Ballroom”');
    expect(
      await combinationProblem(w.db, ORG, { primaryRoomId: S, secondaryRoomIds: [N] }),
    ).toContain('already part of');
    expect(
      await combinationProblem(w.db, ORG, { primaryRoomId: N, secondaryRoomIds: [S, S2] }, COMBO),
    ).toBeNull();
  });
});

describe('what a gateway is told', () => {
  it('gets only combinations whose rooms all run on it', async () => {
    const w = world([
      { id: COMBO, name: 'Ballroom', primaryRoomId: N, secondaryRoomIds: [S] },
      {
        id: '77777777-7777-4777-8777-777777777772',
        name: 'Split',
        primaryRoomId: S2,
        secondaryRoomIds: [ELSEWHERE],
      },
    ]);
    expect(await combinationsForGateway(w.db, { id: GW, orgId: ORG })).toEqual([
      {
        id: COMBO,
        name: 'Ballroom',
        primaryRoomId: N,
        secondaryRoomIds: [S],
        secondaryVideo: 'follow',
        secondaryAudio: 'follow',
      },
    ]);
    expect(await combinationsForGateway(w.db, { id: GW2, orgId: ORG })).toEqual([]);
  });

  it('changes the config version when a combination changes, and keeps it when there are none', () => {
    const a = [{ roomId: 'r1', releaseId: 'x', deploymentId: 'd' }];
    const combo = { id: COMBO, name: 'B', primaryRoomId: N, secondaryRoomIds: [S] };
    expect(configVersion(a, ['k'])).toBe(configVersion(a, ['k'], []));
    expect(configVersion(a, ['k'], [combo])).not.toBe(configVersion(a, ['k']));
    expect(configVersion(a, ['k'], [combo])).not.toBe(
      configVersion(a, ['k'], [{ ...combo, secondaryVideo: 'blank' }]),
    );
  });

  it('takes the joined state only from the gateway the combination runs on', async () => {
    const w = world([{ id: COMBO, name: 'Ballroom', primaryRoomId: N, secondaryRoomIds: [S] }]);
    await recordCombined(w.db, { id: GW2, orgId: ORG }, [{ id: COMBO, combined: true }]);
    expect(w.roomCombination.rows[0]!.combined).toBe(false);
    await recordCombined(w.db, { id: GW, orgId: ORG }, [{ id: COMBO, combined: true }]);
    expect(w.roomCombination.rows[0]!.combined).toBe(true);
  });
});

describe('joining from the portal', () => {
  const ask = (w: ReturnType<typeof world>, over = {}) =>
    queueCombine(w.db as never, {
      orgId: ORG,
      combinationId: COMBO,
      combined: true,
      by: 'u1',
      ...over,
    });

  it('queues a request for the main room’s gateway and audits it', async () => {
    const w = world([{ id: COMBO, name: 'Ballroom', primaryRoomId: N, secondaryRoomIds: [S] }]);
    expect(await ask(w)).toEqual({ ok: true });
    expect(w.controlIntent.rows[0]).toMatchObject({
      gatewayId: GW,
      roomId: N,
      intent: { type: 'combination.set', combinationId: COMBO, combined: true },
    });
    expect(w.auditLog.rows[0]).toMatchObject({ action: 'combination.set', actorId: 'u1' });
  });

  it('never touches another organisation’s combination', async () => {
    const w = world([{ id: COMBO, name: 'Ballroom', primaryRoomId: N, secondaryRoomIds: [S] }]);
    expect(await ask(w, { orgId: OTHER })).toEqual({ ok: false, error: 'Combination not found' });
    expect(w.controlIntent.rows).toHaveLength(0);
  });
});
