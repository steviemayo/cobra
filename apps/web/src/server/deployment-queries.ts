import { db } from '@kestrel/db';
import { effectiveStatus } from './gateway-service';
import { computeSync, unpublishedChanges, type SyncState } from './drift';

export interface ReleaseRef {
  id: string;
  number: number;
}

export interface RoomDeployState {
  roomId: string;
  state: SyncState;
  /** A newer release exists than the one this room is set to run. */
  undeployedRelease: boolean;
  /** The design has been edited since the latest release. */
  unpublishedChanges: boolean;
  desiredRelease: ReleaseRef | null;
  reportedRelease: ReleaseRef | null;
  latestRelease: ReleaseRef | null;
  /** The deployment that set the desired release. */
  deployment: {
    id: string;
    status: string;
    kind: string;
    error: string | null;
    createdAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
  } | null;
  /** Deployments waiting for their time. */
  scheduled: { id: string; releaseNumber: number; scheduledFor: Date }[];
}

/** Deploy state for rooms of one org, in a fixed number of queries however many rooms there are. */
export async function roomDeployStates(orgId: string, roomIds?: string[]): Promise<RoomDeployState[]> {
  const scope = { orgId, ...(roomIds && { id: { in: roomIds } }) };
  const rooms = await db.room.findMany({
    where: scope,
    select: {
      id: true,
      gatewayId: true,
      desiredReleaseId: true,
      desiredDeploymentId: true,
      reportedReleaseId: true,
      reportedHash: true,
      reportedAt: true,
    },
  });
  if (rooms.length === 0) return [];
  const ids = rooms.map((r) => r.id);
  const gatewayIds = [...new Set(rooms.flatMap((r) => (r.gatewayId ? [r.gatewayId] : [])))];
  const releaseIds = [...new Set(rooms.flatMap((r) => [r.desiredReleaseId, r.reportedReleaseId].filter((x): x is string => !!x)))];
  const deploymentIds = rooms.flatMap((r) => (r.desiredDeploymentId ? [r.desiredDeploymentId] : []));

  const [gateways, latest, known, drafts, deployments, scheduled] = await Promise.all([
    db.gateway.findMany({
      where: { orgId, id: { in: gatewayIds } },
      select: { id: true, enrolledAt: true, lastSeenAt: true },
    }),
    db.release.findMany({
      where: { orgId, roomId: { in: ids } },
      orderBy: { number: 'desc' },
      distinct: ['roomId'],
      select: { id: true, roomId: true, number: true, draftRevision: true },
    }),
    db.release.findMany({
      where: { orgId, id: { in: releaseIds } },
      select: { id: true, number: true, hash: true },
    }),
    db.roomDraft.findMany({ where: { orgId, roomId: { in: ids } }, select: { roomId: true, revision: true } }),
    db.deployment.findMany({
      where: { orgId, id: { in: deploymentIds } },
      select: { id: true, status: true, kind: true, error: true, createdAt: true, startedAt: true, finishedAt: true },
    }),
    db.deployment.findMany({
      where: { orgId, roomId: { in: ids }, status: 'scheduled' },
      orderBy: { scheduledFor: 'asc' },
      select: { id: true, roomId: true, scheduledFor: true, release: { select: { number: true } } },
    }),
  ]);

  const gatewayById = new Map(gateways.map((g) => [g.id, g]));
  const latestByRoom = new Map(latest.map((r) => [r.roomId, r]));
  const releaseById = new Map(known.map((r) => [r.id, r]));
  const draftByRoom = new Map(drafts.map((d) => [d.roomId, d.revision]));
  const deploymentById = new Map(deployments.map((d) => [d.id, d]));

  return rooms.map((room): RoomDeployState => {
    const gw = room.gatewayId ? gatewayById.get(room.gatewayId) : undefined;
    const desired = room.desiredReleaseId ? releaseById.get(room.desiredReleaseId) : undefined;
    const reported = room.reportedReleaseId ? releaseById.get(room.reportedReleaseId) : undefined;
    const latestRelease = latestByRoom.get(room.id) ?? null;
    const deployment = room.desiredDeploymentId ? (deploymentById.get(room.desiredDeploymentId) ?? null) : null;
    return {
      roomId: room.id,
      state: computeSync({
        gatewayId: room.gatewayId,
        gatewayStatus: gw ? effectiveStatus(gw) : null,
        desiredReleaseId: room.desiredReleaseId,
        desiredHash: desired?.hash ?? null,
        reportedReleaseId: room.reportedReleaseId,
        reportedHash: room.reportedHash,
        reportedAt: room.reportedAt,
        deploymentStatus: deployment?.status ?? null,
      }),
      undeployedRelease: !!latestRelease && latestRelease.id !== room.desiredReleaseId,
      unpublishedChanges: unpublishedChanges(draftByRoom.get(room.id) ?? null, latestRelease),
      desiredRelease: desired ? { id: desired.id, number: desired.number } : null,
      reportedRelease: reported ? { id: reported.id, number: reported.number } : null,
      latestRelease: latestRelease ? { id: latestRelease.id, number: latestRelease.number } : null,
      deployment,
      scheduled: scheduled
        .filter((s) => s.roomId === room.id)
        .map((s) => ({ id: s.id, releaseNumber: s.release.number, scheduledFor: s.scheduledFor! })),
    };
  });
}
