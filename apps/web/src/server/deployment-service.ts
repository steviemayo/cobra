import type { PrismaClient } from '@kestrel/db';
import type { DeploymentReport } from '@kestrel/model';
import { IN_FLIGHT, SETTLED, isRefused } from './drift';

// Deployments: one attempt to put a release on a room's gateway. These functions take the database
// as a parameter so they can be tested without one.
export type DeploymentDb = Pick<PrismaClient, 'room' | 'deployment' | 'deploymentEvent'>;

export type DeploymentKind = 'deploy' | 'rollback';

export interface NewDeployment {
  orgId: string;
  roomId: string;
  gatewayId: string;
  releaseId: string;
  kind: DeploymentKind;
  createdBy: string | null;
  /** A time in the future to wait for, or null to start now. */
  scheduledFor: Date | null;
}

/** Older attempts still in progress are replaced, so a room only ever works towards one release. */
async function supersedeInFlight(db: DeploymentDb, roomId: string, now: Date) {
  await db.deployment.updateMany({
    where: { roomId, status: { in: [...IN_FLIGHT] } },
    data: { status: 'superseded', finishedAt: now },
  });
}

async function makeDesired(db: DeploymentDb, roomId: string, releaseId: string, deploymentId: string) {
  await db.room.update({
    where: { id: roomId },
    data: { desiredReleaseId: releaseId, desiredDeploymentId: deploymentId },
  });
}

export async function createDeployment(db: DeploymentDb, input: NewDeployment, now = new Date()) {
  const later = input.scheduledFor !== null && input.scheduledFor.getTime() > now.getTime();
  if (later) {
    return db.deployment.create({
      data: {
        orgId: input.orgId,
        roomId: input.roomId,
        gatewayId: input.gatewayId,
        releaseId: input.releaseId,
        kind: input.kind,
        status: 'scheduled',
        scheduledFor: input.scheduledFor,
        createdBy: input.createdBy,
      },
    });
  }
  await supersedeInFlight(db, input.roomId, now);
  const created = await db.deployment.create({
    data: {
      orgId: input.orgId,
      roomId: input.roomId,
      gatewayId: input.gatewayId,
      releaseId: input.releaseId,
      kind: input.kind,
      status: 'pending',
      createdBy: input.createdBy,
    },
  });
  await makeDesired(db, input.roomId, input.releaseId, created.id);
  return created;
}

/** Only a deployment that has not started can be cancelled. Returns whether it was. */
export async function cancelScheduled(db: DeploymentDb, orgId: string, deploymentId: string, now = new Date()) {
  const { count } = await db.deployment.updateMany({
    where: { id: deploymentId, orgId, status: 'scheduled' },
    data: { status: 'cancelled', finishedAt: now },
  });
  return count > 0;
}

/**
 * Start scheduled deployments whose time has come, for the rooms of one gateway. Runs on that
 * gateway's heartbeat, so a deployment starts within one heartbeat of its time.
 */
export async function promoteDue(db: DeploymentDb, gatewayId: string, now = new Date()) {
  const rooms = await db.room.findMany({ where: { gatewayId }, select: { id: true } });
  if (rooms.length === 0) return 0;
  const due = await db.deployment.findMany({
    where: { roomId: { in: rooms.map((r) => r.id) }, status: 'scheduled', scheduledFor: { lte: now } },
    orderBy: { scheduledFor: 'asc' },
  });
  // Oldest first, so if a room has several due the most recent one is the one that ends up wanted.
  for (const d of due) {
    await supersedeInFlight(db, d.roomId, now);
    await db.deployment.update({ where: { id: d.id }, data: { status: 'pending', gatewayId } });
    await makeDesired(db, d.roomId, d.releaseId, d.id);
  }
  return due.length;
}

/** Record what a gateway says happened to a deployment. Settled deployments are never reopened. */
export async function applyReport(
  db: DeploymentDb,
  orgId: string,
  roomId: string,
  report: DeploymentReport,
  now = new Date(),
) {
  const dep = await db.deployment.findFirst({ where: { id: report.deploymentId, roomId, orgId } });
  if (!dep || (SETTLED as readonly string[]).includes(dep.status)) return;

  // Gateway clocks can be wrong; never record a time well into the future.
  const at = (iso: string) => new Date(Math.min(Date.parse(iso), now.getTime() + 60_000));
  await db.deploymentEvent.createMany({
    data: report.history.map((h) => ({ deploymentId: dep.id, stage: h.stage, at: at(h.at) })),
    skipDuplicates: true,
  });
  const terminal = report.stage === 'active' || isRefused(report.stage);
  const times = report.history.map((h) => at(h.at).getTime());
  await db.deployment.update({
    where: { id: dep.id },
    data: {
      status: report.stage,
      startedAt: dep.startedAt ?? new Date(times.length ? Math.min(...times) : now.getTime()),
      finishedAt: terminal ? now : null,
      error: report.error ?? null,
    },
  });
}
