import { describe, expect, it } from 'vitest';
import { generateSealKey, hashSecret } from '@kestrel/crypto';
import {
  AnnounceError,
  MAX_NEW_PER_ADDRESS_PER_DAY,
  MAX_OPEN_UNCLAIMED,
  announce,
  claimUnclaimed,
  deleteUnclaimed,
  dismissUnclaimed,
  listUnclaimed,
  pruneUnclaimed,
  releaseClaim,
  reopenUnclaimed,
  type AnnounceDb,
} from './gateway-announce';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const T0 = new Date('2026-09-28T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const KEY = generateSealKey();

function world() {
  const unclaimedGateway = table([]);
  const gateway = table([]);
  const site = table([{ id: SITE, orgId: ORG, name: 'Head office' }]);
  const auditLog = table([]);
  return {
    db: { unclaimedGateway, gateway, site, auditLog } as unknown as AnnounceDb,
    unclaimedGateway,
    gateway,
    auditLog,
  };
}

const hello = (over: Record<string, unknown> = {}) => ({
  protocol: 1,
  installId: 'install-abcdefghijklmnop',
  secret: 'secret-secret-secret-secret',
  gatewayVersion: '0.2.5',
  hostname: 'ROOM-PC',
  os: 'win32 10.0.22631',
  localAddresses: ['192.168.3.10'],
  ...over,
});
const ctx = { ip: '203.0.113.5', key: KEY };

describe('a gateway announcing itself', () => {
  it('is listed as unclaimed, with only a hash of its secret kept', async () => {
    const w = world();
    const r = await announce(w.db, hello(), ctx, T0);
    expect(r).toEqual({ status: 200, body: { status: 'unclaimed', retrySeconds: 60 } });
    const row = w.unclaimedGateway.rows[0]!;
    expect(row).toMatchObject({
      installId: 'install-abcdefghijklmnop',
      hostname: 'ROOM-PC',
      publicIp: '203.0.113.5',
      status: 'open',
    });
    expect(row.secretHash).toBe(hashSecret('secret-secret-secret-secret'));
    expect(JSON.stringify(row)).not.toContain('secret-secret-secret-secret');
  });

  it('is recognised again by its secret, and refreshed', async () => {
    const w = world();
    await announce(w.db, hello(), ctx, T0);
    const r = await announce(
      w.db,
      hello({ gatewayVersion: '0.2.6', hostname: 'RENAMED' }),
      { ...ctx, ip: '203.0.113.6' },
      at(60_000),
    );
    expect(r.status).toBe(200);
    expect(w.unclaimedGateway.rows).toHaveLength(1);
    expect(w.unclaimedGateway.rows[0]).toMatchObject({
      version: '0.2.6',
      hostname: 'RENAMED',
      publicIp: '203.0.113.6',
      lastSeenAt: at(60_000),
    });
  });

  it('refuses the same install id with the wrong secret, and tells it nothing', async () => {
    const w = world();
    await announce(w.db, hello(), ctx, T0);
    const r = await announce(
      w.db,
      hello({ secret: 'another-secret-another-secret' }),
      ctx,
      at(1000),
    );
    expect(r).toEqual({ status: 403, body: { error: 'Not recognised' } });
    expect(w.unclaimedGateway.rows[0]!.lastSeenAt).toEqual(T0);
  });

  it('refuses a malformed announcement', async () => {
    const w = world();
    expect((await announce(w.db, hello({ installId: 'short' }), ctx, T0)).status).toBe(400);
    expect((await announce(w.db, hello({ secret: 'x' }), ctx, T0)).status).toBe(400);
    expect(
      (await announce(w.db, hello({ localAddresses: Array(20).fill('10.0.0.1') }), ctx, T0)).status,
    ).toBe(400);
    expect((await announce(w.db, undefined, ctx, T0)).status).toBe(400);
    expect(w.unclaimedGateway.rows).toHaveLength(0);
  });

  it('limits how many new gateways one address can add in a day, and how many are held in all', async () => {
    const w = world();
    for (let i = 0; i < MAX_NEW_PER_ADDRESS_PER_DAY; i++)
      expect(
        (
          await announce(
            w.db,
            hello({ installId: `install-number-${String(i).padStart(4, '0')}x` }),
            ctx,
            T0,
          )
        ).status,
      ).toBe(200);
    expect(
      (await announce(w.db, hello({ installId: 'install-one-too-many-x' }), ctx, T0)).status,
    ).toBe(429);
    // A day later, and from anywhere else, it is fine again.
    expect(
      (
        await announce(
          w.db,
          hello({ installId: 'install-one-too-many-x' }),
          ctx,
          at(86_400_000 + 1),
        )
      ).status,
    ).toBe(200);

    const full = world();
    for (let i = 0; i < MAX_OPEN_UNCLAIMED; i++)
      full.unclaimedGateway.rows.push({
        id: `r${i}`,
        installId: `i${i}`,
        secretHash: 'x',
        status: i === 0 ? 'dismissed' : 'open', // the oldest (r0) is dismissed: both pools are evictable
        publicIp: `10.0.${i % 200}.${i % 250}`,
        firstSeenAt: T0,
        lastSeenAt: at(i * 1000), // r0 is the oldest
      });
    // A real, new install still gets in: the one least likely to matter (oldest, unclaimed) makes
    // room for it, rather than the whole endpoint refusing every new gateway once it fills up.
    const res = await announce(full.db, hello(), { ip: '198.51.100.9', key: KEY }, T0);
    expect(res.status).toBe(200);
    expect(full.unclaimedGateway.rows).toHaveLength(MAX_OPEN_UNCLAIMED);
    expect(full.unclaimedGateway.rows.find((r) => r.id === 'r0')).toBeUndefined();
    expect(full.unclaimedGateway.rows.find((r) => r.installId === 'install-abcdefghijklmnop')).toBeTruthy();
  });

  it('never evicts a gateway staff have already claimed to make room', async () => {
    const full = world();
    // r0 is claimed and the oldest row of all; r1..r500 (500 of them) are open and newer, so the
    // cap is reached by the open ones alone.
    full.unclaimedGateway.rows.push({
      id: 'r0',
      installId: 'i0',
      secretHash: 'x',
      status: 'claimed',
      publicIp: '10.0.0.1',
      firstSeenAt: T0,
      lastSeenAt: T0,
    });
    for (let i = 1; i <= MAX_OPEN_UNCLAIMED; i++)
      full.unclaimedGateway.rows.push({
        id: `r${i}`,
        installId: `i${i}`,
        secretHash: 'x',
        status: 'open',
        publicIp: `10.0.${i % 200}.${i % 250}`,
        firstSeenAt: T0,
        lastSeenAt: at(i * 1000),
      });
    const res = await announce(full.db, hello(), { ip: '198.51.100.9', key: KEY }, T0);
    expect(res.status).toBe(200);
    expect(full.unclaimedGateway.rows.find((r) => r.id === 'r0')).toBeTruthy();
    expect(full.unclaimedGateway.rows.find((r) => r.id === 'r1')).toBeUndefined();
  });
});

describe('claiming an unclaimed gateway', () => {
  const claimed = async () => {
    const w = world();
    await announce(w.db, hello(), ctx, T0);
    const id = w.unclaimedGateway.rows[0]!.id as string;
    const res = await claimUnclaimed(
      w.db,
      { id, orgId: ORG, siteId: SITE, name: 'Boardroom gateway', staffUserId: 'staff-1' },
      KEY,
      T0,
    );
    return { w, id, res };
  };

  it('creates a pending gateway for the organisation and site, and audits it', async () => {
    const { w, res } = await claimed();
    expect(w.gateway.rows).toHaveLength(1);
    expect(w.gateway.rows[0]).toMatchObject({
      id: res.gatewayId,
      orgId: ORG,
      siteId: SITE,
      name: 'Boardroom gateway',
      hostname: 'ROOM-PC',
    });
    expect(w.gateway.rows[0]!.enrolledAt).toBeUndefined();
    expect(w.auditLog.rows[0]).toMatchObject({
      orgId: ORG,
      action: 'gateway.claim',
      target: res.gatewayId,
    });
  });

  it('hands the enrolment token to the install, that install only, until it has enrolled', async () => {
    const { w } = await claimed();
    const r = await announce(w.db, hello(), ctx, at(5_000));
    expect(r.status).toBe(200);
    const body = (r as { body: { status: string; enrollToken?: string } }).body;
    expect(body.status).toBe('claimed');
    // It is the token of the gateway that was made: its hash is what the enrol route looks up.
    expect(hashSecret(body.enrollToken!)).toBe(w.gateway.rows[0]!.enrollTokenHash);
    // A lost reply is fine: it is offered again.
    expect(
      ((await announce(w.db, hello(), ctx, at(15_000))) as { body: { enrollToken?: string } }).body
        .enrollToken,
    ).toBe(body.enrollToken);
    // Someone with only the install id gets nothing.
    expect(
      (await announce(w.db, hello({ secret: 'not-the-secret-not-the-secret' }), ctx, at(20_000)))
        .status,
    ).toBe(403);
    // Once the gateway has enrolled, the token is not offered any more.
    w.gateway.rows[0]!.enrolledAt = at(30_000);
    const after = (await announce(w.db, hello(), ctx, at(40_000))) as {
      body: { status: string; enrollToken?: string };
    };
    expect(after.body.status).toBe('claimed');
    expect(after.body.enrollToken).toBeUndefined();
  });

  it('does not offer a token that has expired', async () => {
    const { w } = await claimed();
    // The token's expiry comes from the real clock (newEnrollToken), so so does "later" here.
    const r = (await announce(w.db, hello(), ctx, new Date(Date.now() + 25 * 3_600_000))) as {
      body: { enrollToken?: string };
    };
    expect(r.body.enrollToken).toBeUndefined();
  });

  it('refuses without a secrets key, for a claimed one, an unknown one, and a site of another organisation', async () => {
    const w = world();
    await announce(w.db, hello(), ctx, T0);
    const id = w.unclaimedGateway.rows[0]!.id as string;
    const input = { id, orgId: ORG, siteId: SITE, name: 'GW', staffUserId: 's' };
    await expect(claimUnclaimed(w.db, input, undefined, T0)).rejects.toThrow('KESTREL_SECRETS_KEY');
    await expect(
      claimUnclaimed(w.db, { ...input, siteId: '33333333-3333-4333-8333-333333333333' }, KEY, T0),
    ).rejects.toThrow('not in that organisation');
    await expect(claimUnclaimed(w.db, { ...input, id: 'nope' }, KEY, T0)).rejects.toThrow(
      'not in the list',
    );
    await expect(claimUnclaimed(w.db, { ...input, name: '  ' }, KEY, T0)).rejects.toThrow('name');
    await claimUnclaimed(w.db, input, KEY, T0);
    await expect(claimUnclaimed(w.db, input, KEY, T0)).rejects.toBeInstanceOf(AnnounceError);
  });

  it('can be taken back until it has connected, and not after', async () => {
    const { w, id } = await claimed();
    await releaseClaim(w.db, id);
    expect(w.gateway.rows).toHaveLength(0);
    expect(w.unclaimedGateway.rows[0]).toMatchObject({ status: 'open', claimTokenSealed: null });
    const again = await claimUnclaimed(
      w.db,
      { id, orgId: ORG, siteId: SITE, name: 'GW', staffUserId: 's' },
      KEY,
      T0,
    );
    w.gateway.rows.find((g) => g.id === again.gatewayId)!.enrolledAt = at(1000);
    await expect(releaseClaim(w.db, id)).rejects.toThrow('already connected');
  });
});

describe('the rest of the list', () => {
  it('a dismissed gateway is told to come back rarely, and can be put back', async () => {
    const w = world();
    await announce(w.db, hello(), ctx, T0);
    const id = w.unclaimedGateway.rows[0]!.id as string;
    await dismissUnclaimed(w.db, id);
    expect(await announce(w.db, hello(), ctx, at(1000))).toEqual({
      status: 200,
      body: { status: 'dismissed', retrySeconds: 3600 },
    });
    await expect(dismissUnclaimed(w.db, id)).rejects.toThrow('not waiting');
    await reopenUnclaimed(w.db, id);
    expect(
      ((await announce(w.db, hello(), ctx, at(2000))) as { body: { status: string } }).body.status,
    ).toBe('unclaimed');
  });

  it('lists what staff need and never the secret or the sealed token', async () => {
    const w = world();
    await announce(w.db, hello(), ctx, T0);
    const id = w.unclaimedGateway.rows[0]!.id as string;
    await claimUnclaimed(
      w.db,
      { id, orgId: ORG, siteId: SITE, name: 'GW', staffUserId: 's' },
      KEY,
      T0,
    );
    const list = await listUnclaimed(w.db);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      hostname: 'ROOM-PC',
      publicIp: '203.0.113.5',
      status: 'claimed',
      claimed: { name: 'GW', enrolled: false },
    });
    const text = JSON.stringify(list);
    expect(text).not.toContain('secretHash');
    expect(text).not.toContain('claimTokenSealed');
  });

  it('removes one, and tidies up gateways that went quiet', async () => {
    const w = world();
    await announce(w.db, hello(), ctx, T0);
    await announce(w.db, hello({ installId: 'install-quiet-quiet-quiet' }), ctx, T0);
    await announce(w.db, hello({ installId: 'install-recent-recent-r' }), ctx, at(31 * 86_400_000));
    expect(await pruneUnclaimed(w.db, at(31 * 86_400_000))).toEqual({ unseen: 2, claimed: 0 });
    expect(w.unclaimedGateway.rows.map((r) => r.installId)).toEqual(['install-recent-recent-r']);
    await deleteUnclaimed(w.db, w.unclaimedGateway.rows[0]!.id as string);
    expect(w.unclaimedGateway.rows).toHaveLength(0);
  });
});
