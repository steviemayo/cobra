import { afterEach, describe, expect, it } from 'vitest';
import { HeartbeatResponse } from '@kestrel/model';
import {
  bundleDigest,
  bundleLocation,
  channelRelease,
  clearReleaseCache,
  type ChannelRelease,
} from './gateway-release';
import {
  cancelUpdate,
  requestUpdate,
  setAutoUpdate,
  updateStep,
  type ReleaseLookup,
  type UpdateDb,
} from './gateway-update-service';
import { UPDATE_STALE_MS, planUpdate, type UpdateInputs } from './gateway-updates';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const GW = '22222222-2222-4222-8222-222222222222';
const T0 = new Date('2026-09-28T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const SHA = 'a'.repeat(64);
/** What CI's signature file looks like: base64 of an Ed25519 signature (64 bytes). */
const SIGNATURE = Buffer.alloc(64, 7).toString('base64');

const release = (version: string | null = '0.2.5'): ChannelRelease => ({
  channel: 'stable',
  version,
  assets: [
    { name: 'VERSION', url: 'https://api/asset/1' },
    {
      name: 'kestrel-gateway-win-x64.zip',
      url: 'https://api/asset/2',
      size: 1234,
      digest: `sha256:${SHA}`,
    },
  ],
});
const lookup =
  (r: ChannelRelease | null): ReleaseLookup =>
  async () =>
    r;

function world(over: Record<string, unknown> = {}) {
  const gateway = table([
    {
      id: GW,
      orgId: ORG,
      name: 'Bench',
      channel: 'stable',
      version: '0.2.4',
      features: ['self-update'],
      enrolledAt: T0,
      autoUpdate: false,
      updateNotBefore: null,
      updateVersion: null,
      updateState: null,
      updateError: null,
      updateReportedAt: null,
      ...over,
    },
  ]);
  const auditLog = table([]);
  return { db: { gateway, auditLog } as unknown as UpdateDb, gateway, auditLog };
}
const row = (w: ReturnType<typeof world>) => w.gateway.rows[0]!;

const inputs = (over: Partial<UpdateInputs> = {}): UpdateInputs => ({
  reportedVersion: '0.2.4',
  features: ['self-update'],
  autoUpdate: false,
  request: { notBefore: null, version: null, state: null, reportedAt: null },
  release: { version: '0.2.5' },
  now: T0,
  ...over,
});
const requested = (over: Partial<UpdateInputs['request']> = {}) => ({
  notBefore: T0,
  version: '0.2.5',
  state: null,
  reportedAt: null,
  ...over,
});

describe('what a heartbeat does about updates', () => {
  it('does nothing when nothing was asked and the policy is manual', () => {
    expect(planUpdate(inputs())).toEqual({ kind: 'none' });
  });

  it('orders the update once it is due, and not before', () => {
    expect(planUpdate(inputs({ request: requested() }))).toEqual({
      kind: 'order',
      version: '0.2.5',
    });
    expect(planUpdate(inputs({ request: requested({ notBefore: at(60_000) }) }))).toEqual({
      kind: 'none',
    });
  });

  it('never orders a gateway that cannot take one', () => {
    expect(planUpdate(inputs({ features: [], request: requested() }))).toEqual({ kind: 'none' });
    expect(planUpdate(inputs({ features: [], autoUpdate: true }))).toEqual({ kind: 'none' });
  });

  it('clears the request once the gateway reports the version', () => {
    expect(planUpdate(inputs({ reportedVersion: '0.2.5', request: requested() }))).toEqual({
      kind: 'clear',
    });
    // Or when the channel has nothing newer than it already runs.
    expect(
      planUpdate(
        inputs({ release: { version: '0.2.4' }, request: requested({ version: '0.2.4x' }) }),
      ),
    ).toEqual({
      kind: 'clear',
    });
  });

  it('leaves a failed or unsupported request alone: it is not retried in a loop', () => {
    expect(planUpdate(inputs({ request: requested({ state: 'failed' }) }))).toEqual({
      kind: 'none',
    });
    expect(planUpdate(inputs({ request: requested({ state: 'unsupported' }) }))).toEqual({
      kind: 'none',
    });
  });

  it('keeps ordering while it is in progress, but gives up on one that stalls', () => {
    expect(
      planUpdate(inputs({ request: requested({ state: 'applying', reportedAt: at(-60_000) }) })),
    ).toEqual({ kind: 'order', version: '0.2.5' });
    const stalled = planUpdate(
      inputs({
        request: requested({ state: 'applying', reportedAt: at(-UPDATE_STALE_MS - 1000) }),
      }),
    );
    expect(stalled).toMatchObject({ kind: 'fail' });
  });

  it('the automatic policy asks for the update itself when the channel is ahead', () => {
    expect(planUpdate(inputs({ autoUpdate: true }))).toEqual({
      kind: 'request',
      version: '0.2.5',
      notBefore: T0,
    });
    expect(planUpdate(inputs({ autoUpdate: true, reportedVersion: '0.2.5' }))).toEqual({
      kind: 'none',
    });
    expect(planUpdate(inputs({ autoUpdate: true, release: null }))).toEqual({ kind: 'none' });
  });
});

describe('asking for an update', () => {
  it('records the request, now or from a later time, and audits it', async () => {
    const w = world();
    expect(
      await requestUpdate(
        w.db,
        { orgId: ORG, gatewayId: GW, when: null, userId: 'u1' },
        lookup(release()),
        T0,
      ),
    ).toEqual({ ok: true });
    expect(row(w)).toMatchObject({
      updateNotBefore: T0,
      updateVersion: '0.2.5',
      updateState: null,
    });
    await requestUpdate(
      w.db,
      { orgId: ORG, gatewayId: GW, when: at(3_600_000), userId: 'u1' },
      lookup(release()),
      T0,
    );
    expect(row(w).updateNotBefore).toEqual(at(3_600_000));
    expect(w.auditLog.rows.map((a) => a.action)).toEqual([
      'gateway.update.request',
      'gateway.update.request',
    ]);
  });

  it('refuses a gateway that needs a manual update first, one that is current, and an unreadable release', async () => {
    const old = world({ features: [] });
    expect(
      await requestUpdate(
        old.db,
        { orgId: ORG, gatewayId: GW, when: null, userId: null },
        lookup(release()),
        T0,
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('manual update'),
    });
    const current = world({ version: '0.2.5' });
    expect(
      await requestUpdate(
        current.db,
        { orgId: ORG, gatewayId: GW, when: null, userId: null },
        lookup(release()),
        T0,
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('already on 0.2.5'),
    });
    const w = world();
    expect(
      await requestUpdate(
        w.db,
        { orgId: ORG, gatewayId: GW, when: null, userId: null },
        lookup(null),
        T0,
      ),
    ).toMatchObject({ ok: false });
    expect(row(w).updateNotBefore).toBeNull();
  });

  it('is scoped to the organisation', async () => {
    const w = world();
    const r = await requestUpdate(
      w.db,
      { orgId: '33333333-3333-4333-8333-333333333333', gatewayId: GW, when: null, userId: null },
      lookup(release()),
      T0,
    );
    expect(r).toMatchObject({ ok: false, error: 'Gateway not found' });
  });

  it('can be cancelled, and the automatic policy switched', async () => {
    const w = world({
      updateNotBefore: T0,
      updateVersion: '0.2.5',
      updateState: 'failed',
      updateError: 'x',
    });
    await cancelUpdate(w.db, { orgId: ORG, gatewayId: GW, userId: 'u1' });
    expect(row(w)).toMatchObject({
      updateNotBefore: null,
      updateVersion: null,
      updateState: null,
      updateError: null,
    });
    await setAutoUpdate(w.db, { orgId: ORG, gatewayId: GW, on: true, userId: 'u1' });
    expect(row(w).autoUpdate).toBe(true);
  });
});

describe('the heartbeat step', () => {
  const step = (
    w: ReturnType<typeof world>,
    report: unknown,
    version = '0.2.4',
    now = T0,
    r: ChannelRelease | null = release(),
  ) => updateStep(w.db, row(w) as never, version, report, now, lookup(r));

  it('sends the order, with the digest of the bundle, for a due request', async () => {
    const w = world({ updateNotBefore: T0, updateVersion: '0.2.5' });
    expect(await step(w, undefined)).toEqual({
      version: '0.2.5',
      bundle: { sha256: SHA, size: 1234 },
    });
  });

  it('sends nothing for a request that is not due, or when nobody asked', async () => {
    expect(
      await step(world({ updateNotBefore: at(60_000), updateVersion: '0.2.5' }), undefined),
    ).toBeUndefined();
    expect(await step(world(), undefined)).toBeUndefined();
  });

  it('records what the gateway says about how it is getting on', async () => {
    const w = world({ updateNotBefore: T0, updateVersion: '0.2.5' });
    await step(w, { state: 'failed', version: '0.2.5', error: 'The download failed' });
    expect(row(w)).toMatchObject({
      updateState: 'failed',
      updateError: 'The download failed',
      updateReportedAt: T0,
    });
    // And a failed request is not ordered again.
    expect(await step(w, undefined, '0.2.4', at(30_000))).toBeUndefined();
  });

  it('clears the request and audits it when the gateway is on the new version', async () => {
    const w = world({ updateNotBefore: T0, updateVersion: '0.2.5', updateState: 'applying' });
    expect(await step(w, undefined, '0.2.5')).toBeUndefined();
    expect(row(w)).toMatchObject({ updateNotBefore: null, updateVersion: null, updateState: null });
    expect(w.auditLog.rows.map((a) => a.action)).toEqual(['gateway.update.done']);
  });

  it('marks a stalled update as failed', async () => {
    const w = world({
      updateNotBefore: T0,
      updateVersion: '0.2.5',
      updateState: 'applying',
      updateReportedAt: T0,
    });
    expect(await step(w, undefined, '0.2.4', at(UPDATE_STALE_MS + 1000))).toBeUndefined();
    expect(row(w)).toMatchObject({ updateState: 'failed' });
  });

  it('the automatic policy requests and orders in the same heartbeat', async () => {
    const w = world({ autoUpdate: true });
    expect(await step(w, undefined)).toMatchObject({ version: '0.2.5' });
    expect(row(w)).toMatchObject({ updateNotBefore: T0, updateVersion: '0.2.5' });
    expect(w.auditLog.rows[0]).toMatchObject({ action: 'gateway.update.request' });
  });

  it('sends no order when the portal cannot read the release', async () => {
    const w = world({ updateNotBefore: T0, updateVersion: '0.2.5' });
    expect(await step(w, undefined, '0.2.4', T0, null)).toBeUndefined();
  });

  it('an older gateway can still read a reply that carries an order', () => {
    const body = {
      configVersion: '1',
      serverTime: T0.toISOString(),
      updateOrder: { version: '0.2.5', bundle: { sha256: SHA } },
    };
    // Its schema, from before updateOrder existed: unknown keys are ignored, not an error.
    const before = HeartbeatResponse.omit({ updateOrder: true }).safeParse(body);
    expect(before.success).toBe(true);
    expect(HeartbeatResponse.safeParse(body).data?.updateOrder?.version).toBe('0.2.5');
  });
});

describe('reading the release', () => {
  afterEach(() => clearReleaseCache());
  const github = (
    assets: unknown[],
    versionText = '0.2.5\n',
    redirect: string | null = 'https://objects.example/signed',
    signatureText = SIGNATURE,
  ) => {
    const calls: string[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/releases/tags/'))
        return new Response(JSON.stringify({ assets }), { status: 200 });
      if (url.endsWith('/asset/1')) return new Response(versionText, { status: 200 });
      if (url.endsWith('/asset/3')) return new Response(`${signatureText}\n`, { status: 200 });
      if (url.endsWith('/asset/2') && init?.redirect === 'manual')
        return redirect
          ? new Response(null, { status: 302, headers: { location: redirect } })
          : new Response('nope', { status: 404 });
      return new Response('x', { status: 404 });
    }) as typeof fetch;
    return { fetcher, calls };
  };
  const signatureAsset = { name: 'kestrel-gateway-win-x64.zip.sig', url: 'https://api.example/asset/3' };
  const assets = [...release().assets, signatureAsset];

  it('reads the version and the bundle digest, and caches for a few minutes', async () => {
    const g = github(assets);
    const first = await channelRelease('stable', { fetcher: g.fetcher, env: {}, now: 0 });
    expect(first?.version).toBe('0.2.5');
    expect(bundleDigest(first!)).toEqual({ sha256: SHA, size: 1234 });
    await channelRelease('stable', { fetcher: g.fetcher, env: {}, now: 60_000 });
    expect(g.calls.filter((c) => c.includes('/releases/tags/'))).toHaveLength(1);
    await channelRelease('stable', { fetcher: g.fetcher, env: {}, now: 6 * 60_000 });
    expect(g.calls.filter((c) => c.includes('/releases/tags/'))).toHaveLength(2);
  });

  it('has no digest to offer when GitHub recorded none, so no bundle location either', async () => {
    const g = github(assets.map((a) => ({ ...a, digest: undefined })));
    const r = await channelRelease('stable', { fetcher: g.fetcher, env: {} });
    expect(bundleDigest(r!)).toBeUndefined();
    expect(await bundleLocation('stable', { fetcher: g.fetcher, env: {} })).toBeNull();
  });

  it('hands out the short-lived signed link with the digest, and only that', async () => {
    const g = github(assets);
    expect(
      await bundleLocation('stable', { fetcher: g.fetcher, env: { GITHUB_RELEASE_TOKEN: 't' } }),
    ).toEqual({
      url: 'https://objects.example/signed',
      sha256: SHA,
      size: 1234,
      version: '0.2.5',
      signature: SIGNATURE,
    });
  });

  it('passes CI’s signature on untouched, for the gateway to check with a key the portal does not hold', async () => {
    const g = github(assets);
    const loc = await bundleLocation('stable', { fetcher: g.fetcher, env: {} });
    expect(loc?.signature).toBe(SIGNATURE);
  });

  it('offers the bundle without a signature when the release has none, or a malformed one', async () => {
    const without = github(assets.filter((a) => a.name !== 'kestrel-gateway-win-x64.zip.sig'));
    expect((await bundleLocation('stable', { fetcher: without.fetcher, env: {} }))?.signature).toBeUndefined();
    clearReleaseCache();
    const garbled = github(assets, '0.2.5\n', 'https://objects.example/signed', '<html>not a signature</html>');
    expect((await bundleLocation('stable', { fetcher: garbled.fetcher, env: {} }))?.signature).toBeUndefined();
  });

  it('says so when the release cannot be read', async () => {
    const down = (async () => new Response('no', { status: 500 })) as typeof fetch;
    expect(await channelRelease('stable', { fetcher: down, env: {} })).toBeNull();
    expect(await bundleLocation('stable', { fetcher: down, env: {} })).toBeNull();
  });
});
