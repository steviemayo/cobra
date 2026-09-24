import { createHash } from 'node:crypto';
import { generateSecret, hashSecret } from '@kestrel/crypto';
import type { PrismaClient } from '@kestrel/db';
import {
  EnrollRequest,
  HeartbeatRequest,
  TelemetryBatch,
  type AssignedRoom,
  type PublicKey,
} from '@kestrel/model';
import { applyReport, promoteDue } from './deployment-service';

// The cloud's half of the gateway protocol. Route handlers are thin wrappers over these functions,
// which take the database as a parameter so they can be tested without one.
export type Db = Pick<
  PrismaClient,
  'gateway' | 'room' | 'release' | 'gatewayEvent' | 'auditLog' | 'deployment' | 'deploymentEvent'
>;
type GatewayRow = NonNullable<Awaited<ReturnType<Db['gateway']['findFirst']>>>;
export interface Result {
  status: number;
  body: unknown;
}

export const HEARTBEAT_SECONDS = 30;
/** A gateway that has missed three heartbeats is offline. */
export const OFFLINE_AFTER_MS = HEARTBEAT_SECONDS * 3 * 1000;

const fail = (status: number, error: string): Result => ({ status, body: { error } });

export function effectiveStatus(
  gw: { enrolledAt: Date | null; lastSeenAt: Date | null },
  now = Date.now(),
): 'pending' | 'online' | 'offline' {
  if (!gw.enrolledAt) return 'pending';
  if (!gw.lastSeenAt || now - gw.lastSeenAt.getTime() > OFFLINE_AFTER_MS) return 'offline';
  return 'online';
}

/** Changes whenever what a gateway should be running (or trust) changes. */
export function configVersion(
  assignments: { roomId: string; releaseId: string; deploymentId?: string }[],
  keyIds: string[],
): string {
  const canonical = JSON.stringify({
    rooms: [...assignments].sort((a, b) => a.roomId.localeCompare(b.roomId)),
    keys: [...keyIds].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function newEnrollToken(): { token: string; hash: string; expiresAt: Date } {
  const token = generateSecret(24);
  return { token, hash: hashSecret(token), expiresAt: new Date(Date.now() + 24 * 3_600_000) };
}

export async function authenticateGateway(
  db: Db,
  authorization: string | null,
): Promise<GatewayRow | null> {
  const m = /^Bearer (\S{20,200})$/.exec(authorization ?? '');
  if (!m) return null;
  return db.gateway.findFirst({ where: { credentialHash: hashSecret(m[1]!) } });
}

export async function enroll(db: Db, raw: unknown, keys: PublicKey[]): Promise<Result> {
  const parsed = EnrollRequest.safeParse(raw);
  if (!parsed.success) return fail(400, 'Bad enrolment request');
  const { token, hostname, gatewayVersion, os } = parsed.data;
  const gw = await db.gateway.findFirst({
    where: { enrollTokenHash: hashSecret(token), enrolledAt: null },
  });
  if (!gw || !gw.enrollTokenExpiresAt || gw.enrollTokenExpiresAt < new Date())
    return fail(401, 'This enrolment token is invalid, expired or already used');
  if (keys.length === 0) return fail(503, 'The cloud has no signing key configured yet');

  const credential = generateSecret(32);
  const now = new Date();
  // Single use, even under a race: only one caller can flip enrolledAt from null.
  const { count } = await db.gateway.updateMany({
    where: { id: gw.id, enrolledAt: null },
    data: {
      credentialHash: hashSecret(credential),
      enrollTokenHash: null,
      enrollTokenExpiresAt: null,
      enrolledAt: now,
      lastSeenAt: now,
      status: 'online',
      hostname,
      os,
      version: gatewayVersion,
    },
  });
  if (count === 0) return fail(401, 'This enrolment token is invalid, expired or already used');
  await db.auditLog.create({
    data: {
      orgId: gw.orgId,
      actorId: null,
      action: 'gateway.enroll',
      target: gw.id,
      meta: { name: gw.name, hostname },
    },
  });
  return {
    status: 200,
    body: {
      gatewayId: gw.id,
      name: gw.name,
      orgId: gw.orgId,
      credential,
      heartbeatSeconds: HEARTBEAT_SECONDS,
      publicKeys: keys,
    },
  };
}

async function assignments(db: Db, gatewayId: string) {
  const rooms = await db.room.findMany({
    where: { gatewayId, desiredReleaseId: { not: null }, desiredDeploymentId: { not: null } },
    select: { id: true, name: true, desiredReleaseId: true, desiredDeploymentId: true },
    orderBy: { name: 'asc' },
  });
  const releases = await db.release.findMany({
    where: { id: { in: rooms.map((r) => r.desiredReleaseId!) } },
    select: { id: true, roomId: true, number: true, hash: true },
  });
  const byId = new Map(releases.map((r) => [r.id, r]));
  const out: AssignedRoom[] = [];
  for (const room of rooms) {
    const rel = byId.get(room.desiredReleaseId!);
    if (rel && rel.roomId === room.id)
      out.push({
        roomId: room.id,
        roomName: room.name,
        releaseId: rel.id,
        releaseNumber: rel.number,
        manifestHash: rel.hash,
        deploymentId: room.desiredDeploymentId!,
      });
  }
  return out;
}

export async function heartbeat(db: Db, gw: GatewayRow, raw: unknown, keys: PublicKey[]): Promise<Result> {
  const parsed = HeartbeatRequest.safeParse(raw);
  if (!parsed.success) return fail(400, 'Bad heartbeat');
  const now = new Date();
  await db.gateway.update({
    where: { id: gw.id },
    data: { lastSeenAt: now, status: 'online', version: parsed.data.gatewayVersion },
  });
  // Rooms report themselves; a gateway can only report rooms assigned to it.
  await Promise.all(
    parsed.data.rooms.map(async (r) => {
      const { count } = await db.room.updateMany({
        where: { id: r.roomId, gatewayId: gw.id },
        data: {
          reportedReleaseId: r.releaseId,
          reportedHash: r.manifestHash ?? null,
          reportedStatus: r.status,
          reportedError: r.error ?? null,
          reportedAt: now,
        },
      });
      if (count > 0 && r.deployment) await applyReport(db, gw.orgId, r.roomId, r.deployment, now);
    }),
  );
  // Reports first, so a deployment that just finished is settled before the next one starts.
  await promoteDue(db, gw.id, now);
  const list = await assignments(db, gw.id);
  return {
    status: 200,
    body: {
      configVersion: configVersion(list, keys.map((k) => k.keyId)),
      serverTime: now.toISOString(),
    },
  };
}

export async function config(db: Db, gw: GatewayRow, keys: PublicKey[]): Promise<Result> {
  const rooms = await assignments(db, gw.id);
  return {
    status: 200,
    body: {
      gatewayId: gw.id,
      configVersion: configVersion(rooms, keys.map((k) => k.keyId)),
      rooms,
      publicKeys: keys,
    },
  };
}

export async function manifest(db: Db, gw: GatewayRow, roomId: string, releaseId: string): Promise<Result> {
  const room = await db.room.findFirst({ where: { id: roomId, gatewayId: gw.id } });
  // Only the release currently assigned to this gateway's room can be downloaded.
  if (!room || room.desiredReleaseId !== releaseId) return fail(404, 'No such release for this gateway');
  const release = await db.release.findFirst({ where: { id: releaseId, roomId } });
  if (!release) return fail(404, 'No such release for this gateway');
  return { status: 200, body: release.manifest };
}

export async function telemetry(db: Db, gw: GatewayRow, raw: unknown): Promise<Result> {
  const parsed = TelemetryBatch.safeParse(raw);
  if (!parsed.success) return fail(400, 'Bad telemetry batch');
  const claimed = [...new Set(parsed.data.events.flatMap((e) => (e.roomId ? [e.roomId] : [])))];
  const ownRooms = claimed.length
    ? new Set(
        (
          await db.room.findMany({ where: { id: { in: claimed }, gatewayId: gw.id }, select: { id: true } })
        ).map((r) => r.id),
      )
    : new Set<string>();
  const { count } = await db.gatewayEvent.createMany({
    data: parsed.data.events.map((e) => ({
      orgId: gw.orgId,
      gatewayId: gw.id,
      roomId: e.roomId && ownRooms.has(e.roomId) ? e.roomId : null,
      type: e.type,
      at: new Date(e.at),
      data: e.data as object,
    })),
  });
  return { status: 200, body: { accepted: count } };
}
