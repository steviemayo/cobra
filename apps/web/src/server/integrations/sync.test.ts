import { beforeEach, describe, expect, it } from 'vitest';
import { generateSealKey, seal } from '@kestrel/crypto';
import { clearZoomTokens, normaliseRoom } from './zoom';
import {
  OFFLINE_GRACE_MS,
  STALE_AFTER_MS,
  SYNC_EVERY_MS,
  syncDue,
  syncIntegration,
  type IntegrationDb,
} from './sync';
import type { ProviderDeps } from './types';
import { table } from '../test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222221';
const OTHER_SITE = '22222222-2222-4222-8222-222222222222';
const INT = '55555555-5555-4555-8555-555555555551';
const DEV = '66666666-6666-4666-8666-666666666661';
const T0 = new Date('2026-10-06T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const key = generateSealKey();
const creds = { accountId: 'acc', clientId: 'cid', clientSecret: 'shh' };

beforeEach(clearZoomTokens);

type ZoomRoom = Record<string, unknown>;
function fakeFetch(rooms: ZoomRoom[], opts: { tokenStatus?: number; listStatus?: number } = {}) {
  const calls: string[] = [];
  const f = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('https://zoom.us/oauth/token'))
      return Response.json(
        opts.tokenStatus && opts.tokenStatus !== 200
          ? { reason: 'bad' }
          : { access_token: 'tok', expires_in: 3600 },
        { status: opts.tokenStatus ?? 200 },
      );
    if (u.startsWith('https://api.zoom.us/v2/metrics/zoomrooms'))
      return Response.json({ zoom_rooms: rooms }, { status: opts.listStatus ?? 200 });
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { deps: { fetch: f, now: () => T0.getTime() } satisfies ProviderDeps, calls };
}

function world(
  over: Record<string, unknown> = {},
  devices: Record<string, unknown>[] = [],
  now = T0,
) {
  const integration = table([
    {
      id: INT,
      orgId: ORG,
      provider: 'zoom',
      name: 'Zoom',
      enabled: true,
      siteIds: [],
      defaultSiteId: SITE,
      autoCreate: false,
      sealed: seal(JSON.stringify(creds), key),
      lastSyncAt: null,
      lastOkAt: null,
      lastError: null,
      ...over,
    },
  ]);
  const device = table(devices);
  const db = {
    integration,
    device,
    deviceHistory: table([]),
    deviceEvent: table([]),
    site: table([
      { id: SITE, orgId: ORG },
      { id: OTHER_SITE, orgId: ORG },
    ]),
    room: table([]),
    incident: table([]),
    deviceStatus: table([]),
    gateway: table([]),
    remoteCommand: table([]),
    orgBilling: table([{ id: 'b', orgId: ORG, plan: 'pro', status: 'active', trialEndsAt: now }]),
    org: table([{ id: ORG, createdAt: now }]),
    orgLicenseOverride: table([]),
  } as unknown as IntegrationDb;
  const parts = db as unknown as Record<string, ReturnType<typeof table>>;
  return { db, integration: integration.rows[0] as never, parts };
}

const paired = (extra: Record<string, unknown> = {}) => ({
  id: DEV,
  orgId: ORG,
  siteId: SITE,
  roomId: null,
  name: 'Boardroom Zoom',
  kind: 'active',
  category: 'conference_system',
  integrationId: INT,
  externalId: 'z1',
  online: null,
  since: null,
  feedback: null,
  provenance: {},
  swapPending: false,
  ...extra,
});

describe('normaliseRoom', () => {
  it('maps Zoom status and keeps real faults out of the offline wording', () => {
    const d = normaliseRoom({
      id: 'z1',
      room_name: 'Boardroom',
      status: 'InMeeting',
      issues: ['Camera disconnected', 'Zoom room is offline'],
      device_ip: '10.0.0.5',
    });
    expect(d).toMatchObject({
      externalId: 'z1',
      online: true,
      ip: '10.0.0.5',
      issues: ['Camera disconnected'],
      feedback: { inMeeting: true, roomState: 'in_meeting' },
    });
  });
  it('reads Offline as offline and UnderConstruction as unknown', () => {
    expect(normaliseRoom({ id: 'a', room_name: 'A', status: 'Offline' })?.online).toBe(false);
    expect(normaliseRoom({ id: 'a', room_name: 'A', status: 'UnderConstruction' })?.online).toBe(
      null,
    );
  });
  it('drops records with no id or name', () => {
    expect(normaliseRoom({ room_name: 'x' })).toBeNull();
    expect(normaliseRoom('nope')).toBeNull();
  });
});

describe('syncIntegration', () => {
  it('updates a paired device: state, feedback, history and asset fields', async () => {
    const w = world({}, [paired()]);
    const f = fakeFetch([
      { id: 'z1', room_name: 'Boardroom', status: 'Available', zoom_rooms_version: '6.2.0' },
    ]);
    const res = await syncIntegration(w.db, w.integration, T0, f.deps, key);
    expect(res).toMatchObject({ ok: true, seen: 1, updated: 1, created: 0 });
    const d = w.parts.device!.rows[0]!;
    expect(d).toMatchObject({ online: true, firmware: '6.2.0', make: 'Zoom' });
    expect(d.feedback).toEqual({ inMeeting: false, roomState: 'idle' });
    expect(w.parts.deviceHistory!.rows.map((r) => r.field).sort()).toEqual([
      'inMeeting',
      'online',
      'roomState',
    ]);
    expect(w.parts.integration!.rows[0]).toMatchObject({ lastOkAt: T0, lastError: null });
  });

  it('skips unpaired rooms unless the integration creates them', async () => {
    const w = world();
    const f = fakeFetch([{ id: 'z9', room_name: 'Studio', status: 'Available' }]);
    const res = await syncIntegration(w.db, w.integration, T0, f.deps, key);
    expect(res).toMatchObject({ ok: true, created: 0, skipped: 1 });
    expect(w.parts.device!.rows).toHaveLength(0);
  });

  it('creates a monitored room and device when autoCreate is on, once', async () => {
    const w = world({ autoCreate: true });
    const f = fakeFetch([{ id: 'z9', room_name: 'Studio', status: 'Available' }]);
    const first = await syncIntegration(w.db, w.integration, T0, f.deps, key);
    expect(first.created).toBe(1);
    expect(w.parts.room!.rows[0]).toMatchObject({
      name: 'Studio',
      siteId: SITE,
      monitorOnly: true,
    });
    expect(w.parts.device!.rows[0]).toMatchObject({
      kind: 'active',
      integrationId: INT,
      externalId: 'z9',
      roomId: w.parts.room!.rows[0]!.id,
      online: true,
    });
    const second = await syncIntegration(w.db, w.integration, at(SYNC_EVERY_MS), f.deps, key);
    expect(second).toMatchObject({ created: 0, updated: 1 });
    expect(w.parts.device!.rows).toHaveLength(1);
  });

  it('does not touch devices outside the integration’s sites', async () => {
    const w = world({ siteIds: [OTHER_SITE] }, [paired()]);
    const f = fakeFetch([{ id: 'z1', room_name: 'Boardroom', status: 'Available' }]);
    const res = await syncIntegration(w.db, w.integration, T0, f.deps, key);
    expect(res).toMatchObject({ updated: 0, skipped: 1 });
    expect(w.parts.device!.rows[0]!.online).toBeNull();
  });

  it('opens an offline incident only after the grace period, and resolves it', async () => {
    const w = world({}, [paired({ roomId: null })]);
    const off = fakeFetch([{ id: 'z1', room_name: 'Boardroom', status: 'Offline' }]);
    const a = await syncIntegration(w.db, w.integration, T0, off.deps, key);
    expect(a.jobs).toHaveLength(0);
    const b = await syncIntegration(
      w.db,
      w.integration,
      at(OFFLINE_GRACE_MS + 1000),
      off.deps,
      key,
    );
    expect(b.jobs).toHaveLength(1);
    expect(w.parts.incident!.rows[0]).toMatchObject({ kind: 'device_offline', status: 'open' });
    const on = fakeFetch([{ id: 'z1', room_name: 'Boardroom', status: 'Available' }]);
    const c = await syncIntegration(w.db, w.integration, at(OFFLINE_GRACE_MS * 3), on.deps, key);
    expect(c.jobs).toHaveLength(1);
    expect(w.parts.incident!.rows[0]).toMatchObject({ status: 'resolved' });
  });

  it('keeps one fault incident for the vendor’s issue list and closes it when empty', async () => {
    const w = world({}, [paired()]);
    const bad = fakeFetch([
      {
        id: 'z1',
        room_name: 'Boardroom',
        status: 'Available',
        issues: ['Microphone disconnected'],
      },
    ]);
    await syncIntegration(w.db, w.integration, T0, bad.deps, key);
    expect(w.parts.incident!.rows[0]).toMatchObject({
      kind: 'room_fault',
      title: 'Boardroom Zoom: Microphone disconnected',
    });
    const good = fakeFetch([{ id: 'z1', room_name: 'Boardroom', status: 'Available', issues: [] }]);
    await syncIntegration(w.db, w.integration, at(60_000), good.deps, key);
    expect(w.parts.incident!.rows[0]!.status).toBe('resolved');
  });

  it('records a failed sign-in in plain words and never throws', async () => {
    const w = world({}, [paired({ online: true })]);
    const f = fakeFetch([], { tokenStatus: 401 });
    const res = await syncIntegration(w.db, w.integration, T0, f.deps, key);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/refused the credentials/);
    expect(w.parts.integration!.rows[0]!.lastError).toMatch(/refused the credentials/);
  });

  it('turns devices to unknown once the vendor has been out of reach too long', async () => {
    const w = world({ lastOkAt: T0 }, [paired({ online: true })]);
    const f = fakeFetch([], { tokenStatus: 500 });
    await syncIntegration(w.db, w.integration, at(60_000), f.deps, key);
    expect(w.parts.device!.rows[0]!.online).toBe(true);
    await syncIntegration(w.db, w.integration, at(STALE_AFTER_MS + 60_000), f.deps, key);
    expect(w.parts.device!.rows[0]!.online).toBeNull();
  });

  it('fails clearly with no secrets key', async () => {
    const w = world({}, [paired()]);
    const f = fakeFetch([]);
    const res = await syncIntegration(w.db, w.integration, T0, f.deps, undefined);
    expect(res.error).toMatch(/KESTREL_SECRETS_KEY/);
  });
});

describe('syncDue', () => {
  it('skips integrations read recently and disabled ones', async () => {
    const w = world({ lastSyncAt: at(-1000) }, [paired()]);
    const f = fakeFetch([{ id: 'z1', room_name: 'B', status: 'Available' }]);
    await syncDue(w.db, T0, f.deps);
    expect(f.calls).toHaveLength(0);
    const w2 = world({ enabled: false }, [paired()]);
    await syncDue(w2.db, T0, f.deps);
    expect(f.calls).toHaveLength(0);
  });
});
