import { describe, expect, it } from 'vitest';
import { generateSecret, hashSecret, seal, generateSealKey } from '@kestrel/crypto';
import { handleInbound } from './inbound';
import { parseTeamsEvents } from './teams';
import type { IntegrationDb } from './sync';
import { table } from '../test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222221';
const INT = '55555555-5555-4555-8555-555555555551';
const DEV = '66666666-6666-4666-8666-666666666661';
const T0 = new Date('2026-10-06T10:00:00Z');

const pmp = (state: string, over: Record<string, unknown> = {}, wrap = true) => {
  const data = {
    ID: 'INC-1',
    signal: 'Camera disconnected',
    severity: 'Critical',
    state,
    description: 'The camera is not detected',
    devices: [
      {
        ID: 'dev-abc',
        displayName: 'Boardroom MTR',
        hostname: 'MTR01',
        roomAccount: 'board@x.com',
      },
    ],
    ...over,
  };
  return { ID: 'evt', eventType: 'Incident', data: wrap ? JSON.stringify(data) : data };
};

describe('parseTeamsEvents', () => {
  it('reads a Pro Management incident (data as a JSON string)', () => {
    expect(parseTeamsEvents(pmp('New'))).toEqual([
      {
        kind: 'incident',
        incidentId: 'INC-1',
        keys: ['dev-abc', 'board@x.com', 'MTR01'],
        name: 'Boardroom MTR',
        signal: 'Camera disconnected',
        description: 'The camera is not detected',
        severity: 'critical',
        open: true,
      },
    ]);
  });
  it('accepts data as an object and maps states and severities', () => {
    const [closed] = parseTeamsEvents(pmp('Closed', { severity: 'Recommendation' }, false));
    expect(closed).toMatchObject({ open: false, severity: 'info' });
    expect(parseTeamsEvents(pmp('Investigating', { severity: 'Important' }))[0]).toMatchObject({
      open: true,
      severity: 'warning',
    });
  });
  it('ignores unknown states, no devices and bad data', () => {
    expect(parseTeamsEvents(pmp('Mystery'))).toEqual([]);
    expect(parseTeamsEvents(pmp('New', { devices: [] }))).toEqual([]);
    expect(parseTeamsEvents({ eventType: 'Incident', data: '{oops' })).toEqual([]);
    expect(parseTeamsEvents('nope')).toEqual([]);
  });
  it('reads the admin center offline alert', () => {
    expect(
      parseTeamsEvents({
        AlertTitle: 'Boardroom MTR of Room User has become offline',
        DeviceId: 'dev-abc',
        MetricValues: { DeviceHealthStatus: 'offline' },
      }),
    ).toEqual([{ kind: 'state', key: 'dev-abc', name: 'Boardroom MTR', online: false }]);
    expect(
      parseTeamsEvents({ DeviceId: 'd', MetricValues: { DeviceHealthStatus: 'weird' } }),
    ).toEqual([]);
  });
});

function world(over: Record<string, unknown> = {}, devices: Record<string, unknown>[] = []) {
  const secret = generateSecret();
  const integration = table([
    {
      id: INT,
      orgId: ORG,
      provider: 'teams',
      name: 'Teams',
      enabled: true,
      siteIds: [],
      defaultSiteId: SITE,
      autoCreate: false,
      sealed: seal('{}', generateSealKey()),
      inboundHash: hashSecret(secret),
      lastSyncAt: null,
      lastOkAt: null,
      lastError: null,
      ...over,
    },
  ]);
  const db = {
    integration,
    device: table(devices),
    deviceHistory: table([]),
    deviceEvent: table([]),
    site: table([{ id: SITE, orgId: ORG }]),
    room: table([]),
    incident: table([]),
    deviceStatus: table([]),
    gateway: table([]),
    remoteCommand: table([]),
    orgBilling: table([{ id: 'b', orgId: ORG, plan: 'pro', status: 'active', trialEndsAt: T0 }]),
    org: table([{ id: ORG, createdAt: T0 }]),
    orgLicenseOverride: table([]),
  } as unknown as IntegrationDb;
  const parts = db as unknown as Record<string, ReturnType<typeof table>>;
  return { db, secret, parts };
}

const paired = (extra: Record<string, unknown> = {}) => ({
  id: DEV,
  orgId: ORG,
  siteId: SITE,
  roomId: null,
  name: 'Boardroom',
  kind: 'active',
  category: 'conference_system',
  integrationId: INT,
  externalId: 'dev-abc',
  online: null,
  since: null,
  ...extra,
});

describe('handleInbound', () => {
  it('refuses a wrong secret, a disabled integration and a stranger the same way', async () => {
    const w = world();
    for (const input of [
      { integrationId: INT, secret: 'wrong', body: pmp('New') },
      { integrationId: '55555555-5555-4555-8555-555555555599', secret: w.secret, body: pmp('New') },
    ]) {
      expect(await handleInbound(w.db, input, T0)).toMatchObject({ ok: false, status: 401 });
    }
    const off = world({ enabled: false });
    expect(
      await handleInbound(off.db, { integrationId: INT, secret: off.secret, body: pmp('New') }, T0),
    ).toMatchObject({ ok: false, status: 401 });
  });

  it('opens a fault incident for a paired room, and resolves it when Microsoft does', async () => {
    const w = world({}, [paired()]);
    const open = await handleInbound(
      w.db,
      { integrationId: INT, secret: w.secret, body: pmp('New') },
      T0,
    );
    expect(open).toMatchObject({ ok: true, handled: 1, ignored: 0 });
    expect(w.parts.incident!.rows[0]).toMatchObject({
      kind: 'room_fault',
      severity: 'critical',
      title: 'Boardroom: Camera disconnected',
      status: 'open',
    });
    expect(w.parts.device!.rows[0]).toMatchObject({ online: true });
    const done = await handleInbound(
      w.db,
      { integrationId: INT, secret: w.secret, body: pmp('Resolved') },
      new Date(T0.getTime() + 60_000),
    );
    expect(done).toMatchObject({ ok: true, handled: 1 });
    expect(w.parts.incident!.rows[0]!.status).toBe('resolved');
  });

  it('matches by room account when the device id is not the one paired', async () => {
    const w = world({}, [paired({ externalId: 'board@x.com' })]);
    const r = await handleInbound(
      w.db,
      { integrationId: INT, secret: w.secret, body: pmp('New') },
      T0,
    );
    expect(r).toMatchObject({ ok: true, handled: 1 });
  });

  it('ignores an unpaired room unless the integration creates rooms', async () => {
    const w = world();
    const r = await handleInbound(
      w.db,
      { integrationId: INT, secret: w.secret, body: pmp('New') },
      T0,
    );
    expect(r).toMatchObject({ ok: true, handled: 0, ignored: 1 });
    expect(w.parts.device!.rows).toHaveLength(0);
    const auto = world({ autoCreate: true });
    const r2 = await handleInbound(
      auto.db,
      { integrationId: INT, secret: auto.secret, body: pmp('New') },
      T0,
    );
    expect(r2).toMatchObject({ ok: true, handled: 1 });
    expect(auto.parts.room!.rows[0]).toMatchObject({ name: 'Boardroom MTR', monitorOnly: true });
    expect(auto.parts.device!.rows[0]).toMatchObject({ externalId: 'dev-abc', make: 'Microsoft' });
  });

  it('does not create a room for a close event', async () => {
    const w = world({ autoCreate: true });
    await handleInbound(w.db, { integrationId: INT, secret: w.secret, body: pmp('Closed') }, T0);
    expect(w.parts.device!.rows).toHaveLength(0);
  });

  it('sets offline and online from the admin center alert', async () => {
    const w = world({}, [paired()]);
    const body = (s: string) => ({
      AlertTitle: 'Boardroom of Someone has become offline',
      DeviceId: 'dev-abc',
      MetricValues: { DeviceHealthStatus: s },
    });
    await handleInbound(w.db, { integrationId: INT, secret: w.secret, body: body('offline') }, T0);
    expect(w.parts.device!.rows[0]!.online).toBe(false);
    expect(w.parts.incident!.rows[0]).toMatchObject({ kind: 'device_offline', status: 'open' });
    await handleInbound(
      w.db,
      { integrationId: INT, secret: w.secret, body: body('online') },
      new Date(T0.getTime() + 60_000),
    );
    expect(w.parts.device!.rows[0]!.online).toBe(true);
    expect(w.parts.incident!.rows[0]!.status).toBe('resolved');
  });

  it('refuses a pull integration', async () => {
    const w = world({ provider: 'zoom' }, [paired()]);
    expect(
      await handleInbound(w.db, { integrationId: INT, secret: w.secret, body: pmp('New') }, T0),
    ).toMatchObject({ ok: false, status: 404 });
  });
});
