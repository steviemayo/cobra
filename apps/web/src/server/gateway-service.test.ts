import { describe, expect, it } from 'vitest';
import { generateKeyPair, hashSecret } from '@kestrel/crypto';
import {
  ConfigResponse,
  EnrollResponse,
  HeartbeatResponse,
  PROTOCOL_VERSION,
  type PublicKey,
} from '@kestrel/model';
import {
  authenticateGateway,
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

// ---- A tiny in-memory stand-in for the parts of Prisma the service uses -------------------------

type Row = Record<string, unknown>;
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { not?: unknown; in?: unknown[] };
      if ('not' in c) return v !== c.not;
      if ('in' in c) return c.in!.includes(v);
    }
    return v === cond;
  });
}
function table(rows: Row[]) {
  return {
    rows,
    findFirst: async ({ where }: { where?: Row }) => rows.find((r) => matches(r, where)) ?? null,
    findMany: async ({ where }: { where?: Row }) => rows.filter((r) => matches(r, where)),
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.find((r) => matches(r, where))!;
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    create: async ({ data }: { data: Row }) => {
      rows.push(data);
      return data;
    },
    createMany: async ({ data }: { data: Row[] }) => {
      rows.push(...data);
      return { count: data.length };
    },
  };
}

const ORG = '11111111-1111-4111-8111-111111111111';
const GW = '99999999-9999-4999-8999-999999999991';
const GW2 = '99999999-9999-4999-8999-999999999992';
const ROOM = '33333333-3333-4333-8333-333333333331';
const ROOM2 = '33333333-3333-4333-8333-333333333332';
const REL = '44444444-4444-4444-8444-444444444441';
const REL2 = '44444444-4444-4444-8444-444444444442';
const HASH = 'a'.repeat(64);

function world() {
  const gateway = table([
    { id: GW, orgId: ORG, name: 'HQ gateway', enrollTokenHash: null, enrolledAt: null, credentialHash: null },
    { id: GW2, orgId: ORG, name: 'Other gateway', enrollTokenHash: null, enrolledAt: null, credentialHash: null },
  ]);
  const room = table([
    { id: ROOM, name: 'Boardroom', gatewayId: GW, desiredReleaseId: REL, reportedReleaseId: null },
    { id: ROOM2, name: 'Studio', gatewayId: GW2, desiredReleaseId: REL2, reportedReleaseId: null },
  ]);
  const release = table([
    { id: REL, roomId: ROOM, number: 3, hash: HASH, manifest: { signed: 'boardroom' } },
    { id: REL2, roomId: ROOM2, number: 1, hash: HASH, manifest: { signed: 'studio' } },
  ]);
  const gatewayEvent = table([]);
  const auditLog = table([]);
  const db = { gateway, room, release, gatewayEvent, auditLog } as unknown as Db;
  return { db, gateway, room, release, gatewayEvent, auditLog };
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
  Object.assign(w.gateway.rows.find((g) => g.id === gwId)!, {
    enrollTokenHash: t.hash,
    enrollTokenExpiresAt: t.expiresAt,
    ...over,
  });
  return t.token;
}

describe('helpers', () => {
  it('derives status from enrolment and last contact', () => {
    const now = Date.now();
    expect(effectiveStatus({ enrolledAt: null, lastSeenAt: null }, now)).toBe('pending');
    expect(effectiveStatus({ enrolledAt: new Date(), lastSeenAt: new Date(now - 1000) }, now)).toBe('online');
    expect(
      effectiveStatus({ enrolledAt: new Date(), lastSeenAt: new Date(now - OFFLINE_AFTER_MS - 1) }, now),
    ).toBe('offline');
    expect(effectiveStatus({ enrolledAt: new Date(), lastSeenAt: null }, now)).toBe('offline');
  });

  it('config version is stable, order-independent, and changes with releases or keys', () => {
    const a = [{ roomId: 'r1', releaseId: 'x' }, { roomId: 'r2', releaseId: 'y' }];
    expect(configVersion(a, ['k1'])).toBe(configVersion([...a].reverse(), ['k1']));
    expect(configVersion(a, ['k1'])).not.toBe(configVersion([{ roomId: 'r1', releaseId: 'z' }, a[1]!], ['k1']));
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
    expect(row).toMatchObject({ enrollTokenHash: null, hostname: 'gw-host', version: '0.1.0', status: 'online' });
    expect(w.auditLog.rows[0]).toMatchObject({ action: 'gateway.enroll', target: GW });
  });

  it('tokens are single use, including when two gateways race for one', async () => {
    const w = world();
    const token = withToken(w);
    const [a, b] = await Promise.all([enroll(w.db, enrolReq(token), keys), enroll(w.db, enrolReq(token), keys)]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    expect((await enroll(w.db, enrolReq(token), keys)).status).toBe(401);
  });

  it('rejects unknown, expired and malformed requests without leaking why', async () => {
    const w = world();
    withToken(w);
    expect((await enroll(w.db, enrolReq('not-the-token-000000'), keys)).status).toBe(401);
    const expired = withToken(w, GW, { enrollTokenExpiresAt: new Date(Date.now() - 1000) });
    const res = await enroll(w.db, enrolReq(expired), keys);
    expect(res).toMatchObject({ status: 401, body: { error: expect.stringContaining('invalid, expired or already used') } });
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
      hb([{ roomId: ROOM, releaseId: REL, status: 'on' }, { roomId: ROOM, releaseId: REL, status: 'on', error: undefined }]),
      keys,
    );
    HeartbeatResponse.parse(res.body);
    expect(w.gateway.rows[0]).toMatchObject({ status: 'online', version: '0.2.0' });
    expect(w.gateway.rows[0]!.lastSeenAt).toBeInstanceOf(Date);
    expect(w.room.rows[0]).toMatchObject({ reportedReleaseId: REL, reportedStatus: 'on', reportedError: null });
  });

  it('stores a room error, and ignores rooms that belong to another gateway', async () => {
    const w = world();
    const gw = w.gateway.rows[0]! as never;
    await heartbeat(
      w.db,
      gw,
      hb([
        { roomId: ROOM, releaseId: null, status: 'unloaded', error: 'Release 4 rejected: hash_mismatch' },
        { roomId: ROOM2, releaseId: REL2, status: 'on' },
      ]),
      keys,
    );
    expect(w.room.rows[0]).toMatchObject({ reportedStatus: 'unloaded', reportedError: 'Release 4 rejected: hash_mismatch' });
    expect(w.room.rows[1]!.reportedStatus).toBeUndefined(); // untouched
  });

  it('answers with a config version that changes when a new release is assigned', async () => {
    const w = world();
    const gw = w.gateway.rows[0]! as never;
    const before = HeartbeatResponse.parse((await heartbeat(w.db, gw, hb(), keys)).body).configVersion;
    const newRelease = '44444444-4444-4444-8444-444444444443';
    w.release.rows.push({ id: newRelease, roomId: ROOM, number: 4, hash: HASH, manifest: {} });
    w.room.rows[0]!.desiredReleaseId = newRelease;
    const after = HeartbeatResponse.parse((await heartbeat(w.db, gw, hb(), keys)).body).configVersion;
    expect(after).not.toBe(before);
  });

  it('rejects a malformed heartbeat', async () => {
    const w = world();
    expect((await heartbeat(w.db, w.gateway.rows[0]! as never, { protocol: 99 }, keys)).status).toBe(400);
  });
});

describe('config and manifests', () => {
  it('lists only this gateway’s rooms, with the assigned release', async () => {
    const w = world();
    const res = await config(w.db, w.gateway.rows[0]! as never, keys);
    const body = ConfigResponse.parse(res.body);
    expect(body.rooms).toEqual([
      { roomId: ROOM, roomName: 'Boardroom', releaseId: REL, releaseNumber: 3, manifestHash: HASH },
    ]);
    expect(body.publicKeys).toEqual(keys);
  });

  it('leaves out a room whose assigned release is missing or belongs elsewhere', async () => {
    const w = world();
    w.room.rows[0]!.desiredReleaseId = REL2; // release exists, but for another room
    expect(ConfigResponse.parse((await config(w.db, w.gateway.rows[0]! as never, keys)).body).rooms).toEqual([]);
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
    await telemetry(w.db, w.gateway.rows[0]! as never, batch([{ at, type: 'room.status', roomId: ROOM2 }]));
    expect(w.gatewayEvent.rows[0]!.roomId).toBeNull();
  });

  it('rejects malformed and oversized batches', async () => {
    const w = world();
    const gw = w.gateway.rows[0]! as never;
    expect((await telemetry(w.db, gw, { nonsense: 1 })).status).toBe(400);
    expect((await telemetry(w.db, gw, batch([{ at: 'yesterday', type: 'room.status' }]))).status).toBe(400);
    expect((await telemetry(w.db, gw, batch([{ at, type: 'made.up' }]))).status).toBe(400);
    const many = Array.from({ length: 501 }, () => ({ at, type: 'gateway.started' }));
    expect((await telemetry(w.db, gw, batch(many))).status).toBe(400);
  });
});
