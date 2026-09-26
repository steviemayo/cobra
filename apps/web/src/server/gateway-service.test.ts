import { describe, expect, it } from 'vitest';
import { generateKeyPair, generateSealKey, hashSecret, verifyBindings } from '@kestrel/crypto';
import {
  ConfigResponse,
  EnrollResponse,
  HeartbeatResponse,
  PROTOCOL_VERSION,
  type PublicKey,
} from '@kestrel/model';
import {
  authenticateGateway,
  bindings,
  config,
  configVersion,
  effectiveStatus,
  enroll,
  heartbeat,
  manifest,
  newEnrollToken,
  telemetry,
  OFFLINE_AFTER_MS,
  type Db,
} from './gateway-service';

import { table, type Row } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const GW = '99999999-9999-4999-8999-999999999991';
const GW2 = '99999999-9999-4999-8999-999999999992';
const ROOM = '33333333-3333-4333-8333-333333333331';
const ROOM2 = '33333333-3333-4333-8333-333333333332';
const REL = '44444444-4444-4444-8444-444444444441';
const REL2 = '44444444-4444-4444-8444-444444444442';
const DEP = '55555555-5555-4555-8555-555555555551';
const DEP2 = '55555555-5555-4555-8555-555555555552';
const HASH = 'a'.repeat(64);
const CMD = '66666666-6666-4666-8666-666666666661';

function world() {
  const gateway = table([
    {
      id: GW,
      orgId: ORG,
      name: 'HQ gateway',
      enrollTokenHash: null,
      enrolledAt: null,
      credentialHash: null,
      channel: 'stable',
    },
    {
      id: GW2,
      orgId: ORG,
      name: 'Other gateway',
      enrollTokenHash: null,
      enrolledAt: null,
      credentialHash: null,
    },
  ]);
  const room = table([
    {
      id: ROOM,
      orgId: ORG,
      name: 'Boardroom',
      gatewayId: GW,
      desiredReleaseId: REL,
      desiredDeploymentId: DEP,
      reportedReleaseId: null,
    },
    {
      id: ROOM2,
      orgId: ORG,
      name: 'Studio',
      gatewayId: GW2,
      desiredReleaseId: REL2,
      desiredDeploymentId: DEP2,
      reportedReleaseId: null,
    },
  ]);
  const release = table([
    { id: REL, roomId: ROOM, number: 3, hash: HASH, manifest: { signed: 'boardroom' } },
    { id: REL2, roomId: ROOM2, number: 1, hash: HASH, manifest: { signed: 'studio' } },
  ]);
  const gatewayEvent = table([]);
  const auditLog = table([]);
  const deployment = table([
    {
      id: DEP,
      orgId: ORG,
      roomId: ROOM,
      releaseId: REL,
      gatewayId: GW,
      status: 'pending',
      startedAt: null,
    },
    {
      id: DEP2,
      orgId: ORG,
      roomId: ROOM2,
      releaseId: REL2,
      gatewayId: GW2,
      status: 'pending',
      startedAt: null,
    },
  ]);
  const deploymentEvent = table([], ['deploymentId', 'stage']);
  const deviceStatus = table([]);
  const incident = table([]);
  const remoteCommand = table([]);
  const alertChannel = table([]);
  const alertDelivery = table([]);
  const orgBilling = table([
    { id: 'b1', orgId: ORG, plan: 'pro', status: 'active', trialEndsAt: new Date() },
  ]);
  const org = table([{ id: ORG, createdAt: new Date() }]);
  const controlSession = table([]);
  const controlIntent = table([]);
  const roomGroup = table([]);
  const roomDivider = table([]);
  const roomBinding = table([]);
  const credentialSet = table([]);
  const siteDevice = table([]);
  const db = {
    gateway,
    room,
    release,
    gatewayEvent,
    auditLog,
    deployment,
    deploymentEvent,
    deviceStatus,
    incident,
    remoteCommand,
    alertChannel,
    alertDelivery,
    orgBilling,
    org,
    controlSession,
    controlIntent,
    roomGroup,
    roomDivider,
    roomBinding,
    credentialSet,
    siteDevice,
  } as unknown as Db;
  return {
    db,
    gateway,
    room,
    release,
    gatewayEvent,
    auditLog,
    deployment,
    deploymentEvent,
    deviceStatus,
    incident,
    remoteCommand,
    alertChannel,
    alertDelivery,
    orgBilling,
    org,
    controlSession,
    controlIntent,
    roomGroup,
    roomDivider,
    roomBinding,
    credentialSet,
    siteDevice,
  };
}

const keys: PublicKey[] = [{ keyId: 'k1', publicKeyPem: generateKeyPair().publicKeyPem }];
const enrolReq = (token: string) => ({
  protocol: PROTOCOL_VERSION,
  token,
  hostname: 'gw-host',
  gatewayVersion: '0.1.0',
  os: 'linux 6',
});

function withToken(w: ReturnType<typeof world>, gwId = GW, over: Row = {}) {
  const t = newEnrollToken();
  Object.assign(
    w.gateway.rows.find((g) => g.id === gwId)!,
    {
      enrollTokenHash: t.hash,
      enrollTokenExpiresAt: t.expiresAt,
      ...over,
    },
  );
  return t.token;
}

describe('helpers', () => {
  it('derives status from enrolment and last contact', () => {
    const now = Date.now();
    expect(effectiveStatus({ enrolledAt: null, lastSeenAt: null }, now)).toBe('pending');
    expect(effectiveStatus({ enrolledAt: new Date(), lastSeenAt: new Date(now - 1000) }, now)).toBe(
      'online',
    );
    expect(
      effectiveStatus(
        { enrolledAt: new Date(), lastSeenAt: new Date(now - OFFLINE_AFTER_MS - 1) },
        now,
      ),
    ).toBe('offline');
    expect(effectiveStatus({ enrolledAt: new Date(), lastSeenAt: null }, now)).toBe('offline');
  });

  it('config version is stable, order-independent, and changes with releases or keys', () => {
    const a = [
      { roomId: 'r1', releaseId: 'x' },
      { roomId: 'r2', releaseId: 'y' },
    ];
    expect(configVersion(a, ['k1'])).toBe(configVersion([...a].reverse(), ['k1']));
    expect(configVersion(a, ['k1'])).not.toBe(
      configVersion([{ roomId: 'r1', releaseId: 'z' }, a[1]!], ['k1']),
    );
    expect(configVersion(a, ['k1'])).not.toBe(configVersion(a, ['k1', 'k2']));
    expect(configVersion(a, ['k1'])).toMatch(/^[0-9a-f]{16}$/);
  });

  it('issues unique enrolment tokens that expire in a day', () => {
    const a = newEnrollToken();
    expect(a.token).not.toBe(newEnrollToken().token);
    expect(a.hash).toBe(hashSecret(a.token));
    expect(a.expiresAt.getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
  });
});

describe('enrolment', () => {
  it('exchanges a token for a credential, storing only its hash', async () => {
    const w = world();
    const token = withToken(w);
    const res = await enroll(w.db, enrolReq(token), keys);
    expect(res.status).toBe(200);
    const body = EnrollResponse.parse(res.body); // the same schema the gateway parses with
    expect(body).toMatchObject({ gatewayId: GW, name: 'HQ gateway', orgId: ORG, publicKeys: keys });
    const row = w.gateway.rows[0]!;
    expect(row.credentialHash).toBe(hashSecret(body.credential));
    expect(JSON.stringify(row)).not.toContain(body.credential);
    expect(row).toMatchObject({
      enrollTokenHash: null,
      hostname: 'gw-host',
      version: '0.1.0',
      status: 'online',
    });
    expect(w.auditLog.rows[0]).toMatchObject({ action: 'gateway.enroll', target: GW });
  });

  it('tokens are single use, including when two gateways race for one', async () => {
    const w = world();
    const token = withToken(w);
    const [a, b] = await Promise.all([
      enroll(w.db, enrolReq(token), keys),
      enroll(w.db, enrolReq(token), keys),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    expect((await enroll(w.db, enrolReq(token), keys)).status).toBe(401);
  });

  it('rejects unknown, expired and malformed requests without leaking why', async () => {
    const w = world();
    withToken(w);
    expect((await enroll(w.db, enrolReq('not-the-token-000000'), keys)).status).toBe(401);
    const expired = withToken(w, GW, { enrollTokenExpiresAt: new Date(Date.now() - 1000) });
    const res = await enroll(w.db, enrolReq(expired), keys);
    expect(res).toMatchObject({
      status: 401,
      body: { error: expect.stringContaining('invalid, expired or already used') },
    });
    expect((await enroll(w.db, { nonsense: true }, keys)).status).toBe(400);
    expect((await enroll(w.db, undefined, keys)).status).toBe(400);
  });

  it('refuses to enrol when the cloud has no signing key', async () => {
    const w = world();
    const token = withToken(w);
    expect((await enroll(w.db, enrolReq(token), [])).status).toBe(503);
    expect(w.gateway.rows[0]!.enrolledAt).toBeNull(); // the token is not burned
  });

  it('cannot enrol an already-enrolled gateway again with a leftover token', async () => {
    const w = world();
    const token = withToken(w, GW, { enrolledAt: new Date() });
    expect((await enroll(w.db, enrolReq(token), keys)).status).toBe(401);
  });
});

describe('authentication', () => {
  it('finds the gateway by credential, and only by the right one', async () => {
    const w = world();
    Object.assign(w.gateway.rows[0]!, { credentialHash: hashSecret('c'.repeat(32)) });
    expect((await authenticateGateway(w.db, `Bearer ${'c'.repeat(32)}`))?.id).toBe(GW);
    expect(await authenticateGateway(w.db, `Bearer ${'d'.repeat(32)}`)).toBeNull();
    expect(await authenticateGateway(w.db, 'Bearer short')).toBeNull();
    expect(await authenticateGateway(w.db, `Basic ${'c'.repeat(32)}`)).toBeNull();
    expect(await authenticateGateway(w.db, null)).toBeNull();
  });
});

const hb = (rooms: unknown[] = [], configV: string | null = null) => ({
  protocol: PROTOCOL_VERSION,
  gatewayVersion: '0.2.0',
  uptimeSeconds: 5,
  configVersion: configV,
  rooms,
});

describe('heartbeat', () => {
  it('records contact and what each room is running', async () => {
    const w = world();
    const gw = w.gateway.rows[0]! as never;
    const res = await heartbeat(
      w.db,
      gw,
      hb([
        { roomId: ROOM, releaseId: REL, status: 'on' },
        { roomId: ROOM, releaseId: REL, status: 'on', error: undefined },
      ]),
      keys,
    );
    HeartbeatResponse.parse(res.body);
    expect(w.gateway.rows[0]).toMatchObject({ status: 'online', version: '0.2.0' });
    expect(w.gateway.rows[0]!.lastSeenAt).toBeInstanceOf(Date);
    expect(w.room.rows[0]).toMatchObject({
      reportedReleaseId: REL,
      reportedStatus: 'on',
      reportedError: null,
    });
  });

  it('tells the gateway which channel it follows and the newest version on it', async () => {
    const w = world();
    const gw = { ...w.gateway.rows[0]!, channel: 'beta' } as never;
    const prev = process.env.GATEWAY_LATEST_BETA;
    process.env.GATEWAY_LATEST_BETA = '0.3.0-beta.1';
    try {
      const res = await heartbeat(w.db, gw, hb([]), keys);
      expect(HeartbeatResponse.parse(res.body).update).toEqual({ channel: 'beta', latest: '0.3.0-beta.1' });
    } finally {
      if (prev === undefined) delete process.env.GATEWAY_LATEST_BETA;
      else process.env.GATEWAY_LATEST_BETA = prev;
    }
  });

  it('stores a room error, and ignores rooms that belong to another gateway', async () => {
    const w = world();
    const gw = w.gateway.rows[0]! as never;
    await heartbeat(
      w.db,
      gw,
      hb([
        {
          roomId: ROOM,
          releaseId: null,
          status: 'unloaded',
          error: 'Release 4 rejected: hash_mismatch',
        },
        { roomId: ROOM2, releaseId: REL2, status: 'on' },
      ]),
      keys,
    );
    expect(w.room.rows[0]).toMatchObject({
      reportedStatus: 'unloaded',
      reportedError: 'Release 4 rejected: hash_mismatch',
    });
    expect(w.room.rows[1]!.reportedStatus).toBeUndefined(); // untouched
  });

  it('answers with a config version that changes when a new release is assigned', async () => {
    const w = world();
    const gw = w.gateway.rows[0]! as never;
    const before = HeartbeatResponse.parse(
      (await heartbeat(w.db, gw, hb(), keys)).body,
    ).configVersion;
    const newRelease = '44444444-4444-4444-8444-444444444443';
    w.release.rows.push({ id: newRelease, roomId: ROOM, number: 4, hash: HASH, manifest: {} });
    w.room.rows[0]!.desiredReleaseId = newRelease;
    const after = HeartbeatResponse.parse(
      (await heartbeat(w.db, gw, hb(), keys)).body,
    ).configVersion;
    expect(after).not.toBe(before);
  });

  it('rejects a malformed heartbeat', async () => {
    const w = world();
    expect(
      (await heartbeat(w.db, w.gateway.rows[0]! as never, { protocol: 99 }, keys)).status,
    ).toBe(400);
  });
});

describe('config and manifests', () => {
  it('lists only this gateway’s rooms, with the assigned release', async () => {
    const w = world();
    const res = await config(w.db, w.gateway.rows[0]! as never, keys);
    const body = ConfigResponse.parse(res.body);
    expect(body.rooms).toEqual([
      {
        roomId: ROOM,
        roomName: 'Boardroom',
        releaseId: REL,
        releaseNumber: 3,
        manifestHash: HASH,
        deploymentId: DEP,
      },
    ]);
    expect(body.publicKeys).toEqual(keys);
  });

  it('leaves out a room whose assigned release is missing or belongs elsewhere', async () => {
    const w = world();
    w.room.rows[0]!.desiredReleaseId = REL2; // release exists, but for another room
    expect(
      ConfigResponse.parse((await config(w.db, w.gateway.rows[0]! as never, keys)).body).rooms,
    ).toEqual([]);
  });

  it('serves the assigned release manifest, exactly as stored', async () => {
    const w = world();
    const res = await manifest(w.db, w.gateway.rows[0]! as never, ROOM, REL);
    expect(res).toEqual({ status: 200, body: { signed: 'boardroom' } });
  });

  it('will not serve another gateway’s room, or a release that is not the assigned one', async () => {
    const w = world();
    const gw = w.gateway.rows[0]! as never;
    expect((await manifest(w.db, gw, ROOM2, REL2)).status).toBe(404);
    expect((await manifest(w.db, gw, ROOM, REL2)).status).toBe(404);
    w.release.rows.push({ id: 'old-release', roomId: ROOM, number: 1, hash: HASH, manifest: {} });
    expect((await manifest(w.db, gw, ROOM, 'old-release')).status).toBe(404); // not the desired one
  });
});

describe('telemetry', () => {
  const batch = (events: unknown[]) => ({ protocol: PROTOCOL_VERSION, events });
  const at = new Date().toISOString();

  it('stores events against the gateway and its org', async () => {
    const w = world();
    const res = await telemetry(
      w.db,
      w.gateway.rows[0]! as never,
      batch([{ at, type: 'room.status', roomId: ROOM, data: { status: 'on' } }]),
    );
    expect(res).toEqual({ status: 200, body: { accepted: 1 } });
    expect(w.gatewayEvent.rows[0]).toMatchObject({
      orgId: ORG,
      gatewayId: GW,
      roomId: ROOM,
      type: 'room.status',
      data: { status: 'on' },
    });
    expect(w.gatewayEvent.rows[0]!.at).toEqual(new Date(at));
  });

  it('does not let a gateway attach events to a room that is not its own', async () => {
    const w = world();
    await telemetry(
      w.db,
      w.gateway.rows[0]! as never,
      batch([{ at, type: 'room.status', roomId: ROOM2 }]),
    );
    expect(w.gatewayEvent.rows[0]!.roomId).toBeNull();
  });

  it('rejects malformed and oversized batches', async () => {
    const w = world();
    const gw = w.gateway.rows[0]! as never;
    expect((await telemetry(w.db, gw, { nonsense: 1 })).status).toBe(400);
    expect(
      (await telemetry(w.db, gw, batch([{ at: 'yesterday', type: 'room.status' }]))).status,
    ).toBe(400);
    expect((await telemetry(w.db, gw, batch([{ at, type: 'made.up' }]))).status).toBe(400);
    const many = Array.from({ length: 501 }, () => ({ at, type: 'gateway.started' }));
    expect((await telemetry(w.db, gw, batch(many))).status).toBe(400);
  });
});

describe('deployments over the heartbeat', () => {
  const stages = (...names: string[]) => ({
    deploymentId: DEP,
    stage: names.at(-1),
    history: names.map((stage, i) => ({
      stage,
      at: new Date(Date.UTC(2026, 8, 24, 10, i)).toISOString(),
    })),
  });

  it('applies the deployment a room reports, and stores the running manifest hash', async () => {
    const w = world();
    const gw = w.gateway.rows[0]! as never;
    await heartbeat(
      w.db,
      gw,
      hb([
        {
          roomId: ROOM,
          releaseId: REL,
          manifestHash: HASH,
          status: 'off',
          deployment: stages('downloading', 'verifying', 'staging', 'health_check', 'active'),
        },
      ]),
      keys,
    );
    expect(w.deployment.rows.find((d) => d.id === DEP)).toMatchObject({ status: 'active' });
    expect(w.deploymentEvent.rows).toHaveLength(5);
    expect(w.room.rows[0]).toMatchObject({ reportedHash: HASH });
  });

  it('will not let a gateway report on a room or deployment that is not its own', async () => {
    const w = world();
    const gw2 = w.gateway.rows[1]! as never;
    await heartbeat(
      w.db,
      gw2,
      hb([{ roomId: ROOM, releaseId: REL, status: 'off', deployment: stages('active') }]),
      keys,
    );
    expect(w.deployment.rows.find((d) => d.id === DEP)).toMatchObject({ status: 'pending' });
  });

  it('starts a scheduled deployment when the gateway next checks in, and tells it about it', async () => {
    const w = world();
    const gw = w.gateway.rows[0]! as never;
    const before = (await heartbeat(w.db, gw, hb(), keys)).body as { configVersion: string };
    const NEW = '55555555-5555-4555-8555-555555555559';
    w.deployment.rows.push({
      id: NEW,
      orgId: ORG,
      roomId: ROOM,
      releaseId: REL,
      gatewayId: GW,
      status: 'scheduled',
      scheduledFor: new Date(Date.now() - 1000),
    });
    const after = (await heartbeat(w.db, gw, hb(), keys)).body as { configVersion: string };
    expect(w.deployment.rows.find((d) => d.id === NEW)!.status).toBe('pending');
    expect(w.deployment.rows.find((d) => d.id === DEP)!.status).toBe('superseded');
    expect(after.configVersion).not.toBe(before.configVersion);
    const cfg = ConfigResponse.parse((await config(w.db, gw, keys)).body);
    expect(cfg.rooms[0]!.deploymentId).toBe(NEW);
  });

  it('a new deployment of the same release changes the config version, so the gateway retries', () => {
    const a = [{ roomId: 'r1', releaseId: 'x', deploymentId: 'd1' }];
    expect(configVersion(a, ['k'])).not.toBe(
      configVersion([{ ...a[0]!, deploymentId: 'd2' }], ['k']),
    );
  });

  it('does not send a room that has no deployment to a gateway', async () => {
    const w = world();
    w.room.rows[0]!.desiredDeploymentId = null;
    const cfg = ConfigResponse.parse((await config(w.db, w.gateway.rows[0]! as never, keys)).body);
    expect(cfg.rooms).toEqual([]);
  });
});

describe('monitoring over the heartbeat', () => {
  const dev = (online: boolean) => [{ deviceId: 'dsp', name: 'DSP', online }];
  const report = (online: boolean) => ({
    roomId: ROOM,
    releaseId: REL,
    manifestHash: HASH,
    status: 'off',
    devices: dev(online),
  });

  it('hands queued commands to the gateway once, and takes their results', async () => {
    const w = world();
    const gw = w.gateway.rows[0]! as never;
    w.remoteCommand.rows.push({
      id: CMD,
      orgId: ORG,
      gatewayId: GW,
      roomId: ROOM,
      type: 'diagnostics',
      args: {},
      status: 'pending',
      createdAt: new Date(),
    });
    const first = HeartbeatResponse.parse((await heartbeat(w.db, gw, hb(), keys)).body);
    expect(first.commands).toEqual([{ id: CMD, type: 'diagnostics', roomId: ROOM, args: {} }]);
    expect(HeartbeatResponse.parse((await heartbeat(w.db, gw, hb(), keys)).body).commands).toEqual(
      [],
    );

    await heartbeat(
      w.db,
      gw,
      { ...hb(), commandResults: [{ id: CMD, ok: true, output: { devices: 2 } }] },
      keys,
    );
    expect(w.remoteCommand.rows[0]).toMatchObject({ status: 'succeeded', output: { devices: 2 } });
  });

  it('never gives one gateway another gateway’s commands', async () => {
    const w = world();
    w.remoteCommand.rows.push({
      id: CMD,
      orgId: ORG,
      gatewayId: GW2,
      roomId: ROOM2,
      type: 'diagnostics',
      args: {},
      status: 'pending',
      createdAt: new Date(),
    });
    const res = HeartbeatResponse.parse(
      (await heartbeat(w.db, w.gateway.rows[0]! as never, hb(), keys)).body,
    );
    expect(res.commands).toEqual([]);
  });

  it('opens an incident for a device that stays offline and returns an alert to send after the response', async () => {
    const w = world();
    const gw = w.gateway.rows[0]! as never;
    w.alertChannel.rows.push({
      id: 'ch',
      orgId: ORG,
      type: 'webhook',
      enabled: true,
      minSeverity: 'warning',
      config: { url: 'https://hooks.example.com/x' },
    });
    await heartbeat(w.db, gw, hb([report(false) as never]), keys);
    expect(w.deviceStatus.rows).toHaveLength(1);
    expect(w.incident.rows).toHaveLength(0);
    // The device has now been offline long enough.
    w.deviceStatus.rows[0]!.since = new Date(Date.now() - 120_000);
    const res = await heartbeat(w.db, gw, hb([report(false) as never]), keys);
    expect(w.incident.rows[0]).toMatchObject({
      kind: 'device_offline',
      status: 'open',
      title: 'DSP is offline',
    });
    expect(typeof res.after).toBe('function');
    const back = await heartbeat(w.db, gw, hb([report(true) as never]), keys);
    expect(w.incident.rows[0]!.status).toBe('resolved');
    expect(typeof back.after).toBe('function');
  });

  it('does not add an after-response step when there is nothing to alert about', async () => {
    const w = world();
    const res = await heartbeat(
      w.db,
      w.gateway.rows[0]! as never,
      hb([report(true) as never]),
      keys,
    );
    expect(res.after).toBeUndefined();
  });
});

describe('plan gating over the heartbeat', () => {
  const offlineReport = {
    roomId: ROOM,
    releaseId: REL,
    manifestHash: HASH,
    status: 'fault',
    devices: [{ deviceId: 'dsp', name: 'DSP', online: false }],
  };

  it('stops analysing reports when the plan has no monitoring, but keeps the gateway working', async () => {
    const w = world();
    Object.assign(w.orgBilling.rows[0]!, { plan: 'basic' });
    const gw = w.gateway.rows[0]! as never;
    const res = await heartbeat(w.db, gw, hb([offlineReport as never]), keys);
    expect(res.status).toBe(200);
    expect(w.incident.rows).toHaveLength(0);
    expect(w.deviceStatus.rows).toHaveLength(0);
    // Control carries on: the reported state is still stored and deployments still flow.
    expect(w.room.rows[0]!.reportedStatus).toBe('fault');
    expect(ConfigResponse.parse((await config(w.db, gw, keys)).body).rooms).toHaveLength(1);
  });

  it('cuts monitoring off when a trial runs out, and back on when they subscribe', async () => {
    const w = world();
    Object.assign(w.orgBilling.rows[0]!, {
      plan: 'trial',
      status: 'none',
      trialEndsAt: new Date(Date.now() - 1000),
    });
    const gw = w.gateway.rows[0]! as never;
    await heartbeat(w.db, gw, hb([offlineReport as never]), keys);
    expect(w.incident.rows).toHaveLength(0);
    Object.assign(w.orgBilling.rows[0]!, { plan: 'pro', status: 'active' });
    await heartbeat(w.db, gw, hb([offlineReport as never]), keys);
    expect(w.incident.rows.length).toBeGreaterThan(0);
  });
});

describe('bindings', () => {
  const pair = generateKeyPair();
  const signing = { keyId: 'k1', privateKeyPem: pair.privateKeyPem, publicKeyPem: pair.publicKeyPem };
  const trusted = [{ keyId: 'k1', publicKeyPem: pair.publicKeyPem }];

  it('remembers what a gateway says it can do, and the bindings version each room runs', async () => {
    const w = world();
    const gw = w.gateway.rows[0]! as never;
    const req = { ...hb([{ roomId: ROOM, releaseId: REL, status: 'on', bindingsVersion: 4 }]), features: ['bindings'] };
    await heartbeat(w.db, gw, req, keys);
    expect(w.gateway.rows[0]!.features).toEqual(['bindings']);
    expect(w.room.rows[0]!.reportedBindingsVersion).toBe(4);
  });

  it('assigns a room its bindings version, which changes the config version', async () => {
    const w = world();
    const gw = w.gateway.rows[0]! as never;
    const before = ConfigResponse.parse((await config(w.db, gw, keys)).body);
    expect(before.rooms[0]!.bindingsVersion).toBeUndefined();
    w.roomBinding.rows.push({ id: 'b1', orgId: ORG, roomId: ROOM, version: 2, values: {}, sealed: null, credentialSets: {} });
    const after = ConfigResponse.parse((await config(w.db, gw, keys)).body);
    expect(after.rooms[0]!.bindingsVersion).toBe(2);
    expect(after.configVersion).not.toBe(before.configVersion);
  });

  it('gives a gateway its own room’s bindings, signed', async () => {
    const w = world();
    w.roomBinding.rows.push({
      id: 'b1',
      orgId: ORG,
      roomId: ROOM,
      version: 2,
      values: { dsp: { host: '10.0.0.5' } },
      sealed: null,
      credentialSets: {},
    });
    const res = await bindings(w.db, w.gateway.rows[0]! as never, ROOM, signing);
    expect(res.status).toBe(200);
    const checked = verifyBindings(res.body, trusted);
    expect(checked.ok && checked.signed.payload).toMatchObject({
      orgId: ORG,
      roomId: ROOM,
      version: 2,
      devices: { dsp: { host: '10.0.0.5' } },
    });
  });

  it('refuses a room that belongs to another gateway, and a room with none', async () => {
    const w = world();
    w.roomBinding.rows.push({ id: 'b2', orgId: ORG, roomId: ROOM2, version: 1, values: { a: { host: 'x' } }, sealed: null, credentialSets: {} });
    expect((await bindings(w.db, w.gateway.rows[0]! as never, ROOM2, signing)).status).toBe(404);
    expect((await bindings(w.db, w.gateway.rows[0]! as never, ROOM, signing)).status).toBe(404);
  });

  it('cannot sign without a key, and says so', async () => {
    const w = world();
    expect((await bindings(w.db, w.gateway.rows[0]! as never, ROOM, null)).status).toBe(503);
  });

  it('will not open logins when the server has lost its secrets key', async () => {
    const w = world();
    const sealed = 'v1.not-a-real-seal';
    w.roomBinding.rows.push({ id: 'b1', orgId: ORG, roomId: ROOM, version: 1, values: {}, sealed, credentialSets: {} });
    const prev = process.env.KESTREL_SECRETS_KEY;
    process.env.KESTREL_SECRETS_KEY = generateSealKey();
    try {
      expect((await bindings(w.db, w.gateway.rows[0]! as never, ROOM, signing)).status).toBe(503);
    } finally {
      if (prev === undefined) delete process.env.KESTREL_SECRETS_KEY;
      else process.env.KESTREL_SECRETS_KEY = prev;
    }
  });
});
