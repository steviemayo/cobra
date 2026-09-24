// Deployment states and how a room's deploy state is worked out. Pure, so it can be tested alone.

export const IN_FLIGHT = ['pending', 'downloading', 'verifying', 'staging', 'health_check'] as const;
export const REFUSED = ['failed', 'rolled_back'] as const;
export const SETTLED = ['active', 'failed', 'rolled_back', 'cancelled', 'superseded'] as const;

export const isInFlight = (status: string | null | undefined) =>
  !!status && (IN_FLIGHT as readonly string[]).includes(status);
export const isRefused = (status: string | null | undefined) =>
  !!status && (REFUSED as readonly string[]).includes(status);
export const isSettled = (status: string) => (SETTLED as readonly string[]).includes(status);

/**
 * not_deployed  nothing has been sent to a gateway
 * deploying     a deployment is under way, or the gateway has not reported back yet
 * in_sync       the gateway is running exactly what the cloud wants
 * failed        the gateway refused the release; the previous one (if any) is still running
 * unreachable   the gateway is not in touch, so what is running is unknown
 * drifted       the gateway is running something other than what the cloud wants
 */
export type SyncState = 'not_deployed' | 'deploying' | 'in_sync' | 'failed' | 'unreachable' | 'drifted';

export interface DriftInput {
  gatewayId: string | null;
  gatewayStatus: 'pending' | 'online' | 'offline' | null;
  desiredReleaseId: string | null;
  /** Hash of the desired release's manifest. */
  desiredHash: string | null;
  reportedReleaseId: string | null;
  reportedHash: string | null;
  reportedAt: Date | null;
  /** Status of the deployment that set the desired release. */
  deploymentStatus: string | null;
}

export function computeSync(i: DriftInput): SyncState {
  if (!i.gatewayId || !i.desiredReleaseId) return 'not_deployed';
  // Comparing hashes as well as ids catches a gateway running something mislabelled as this release.
  const running =
    i.reportedReleaseId === i.desiredReleaseId &&
    (!i.reportedHash || !i.desiredHash || i.reportedHash === i.desiredHash);
  if (running) return 'in_sync';
  if (isRefused(i.deploymentStatus)) return 'failed';
  if (i.gatewayStatus !== 'online') return 'unreachable';
  if (isInFlight(i.deploymentStatus) || !i.reportedAt) return 'deploying';
  return 'drifted';
}

export interface RoomSync {
  state: SyncState;
  /** A release newer than the one the room is set to run exists but has not been deployed. */
  undeployedRelease: boolean;
  /** The design has been edited since the latest release was published. */
  unpublishedChanges: boolean;
}

export function unpublishedChanges(
  draftRevision: number | null,
  latestRelease: { draftRevision: number | null } | null,
): boolean {
  if (draftRevision === null) return false;
  if (!latestRelease) return true;
  // Releases published before revisions were recorded can't be compared, so assume nothing changed.
  return latestRelease.draftRevision !== null && draftRevision > latestRelease.draftRevision;
}
