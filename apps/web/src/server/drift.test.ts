import { describe, expect, it } from 'vitest';
import { computeSync, isInFlight, isRefused, isSettled, unpublishedChanges, type DriftInput } from './drift';

const input = (over: Partial<DriftInput> = {}): DriftInput => ({
  gatewayId: 'gw',
  gatewayStatus: 'online',
  desiredReleaseId: 'r2',
  desiredHash: 'h2',
  reportedReleaseId: 'r1',
  reportedHash: 'h1',
  reportedAt: new Date(),
  deploymentStatus: 'pending',
  ...over,
});

describe('computeSync', () => {
  it('is not_deployed without a gateway or a chosen release', () => {
    expect(computeSync(input({ gatewayId: null }))).toBe('not_deployed');
    expect(computeSync(input({ desiredReleaseId: null }))).toBe('not_deployed');
  });

  it('is in_sync when the gateway runs the desired release', () => {
    expect(computeSync(input({ reportedReleaseId: 'r2', reportedHash: 'h2', deploymentStatus: 'active' }))).toBe('in_sync');
  });

  it('is in_sync even if the gateway has gone quiet, since what it last ran matches', () => {
    expect(computeSync(input({ reportedReleaseId: 'r2', reportedHash: 'h2', gatewayStatus: 'offline' }))).toBe('in_sync');
  });

  it('trusts the release id when either hash is unknown, but not when the hashes differ', () => {
    expect(computeSync(input({ reportedReleaseId: 'r2', reportedHash: null }))).toBe('in_sync');
    expect(computeSync(input({ reportedReleaseId: 'r2', desiredHash: null, reportedHash: 'x' }))).toBe('in_sync');
    expect(computeSync(input({ reportedReleaseId: 'r2', reportedHash: 'other', deploymentStatus: 'active' }))).toBe('drifted');
  });

  it('is deploying while a deployment is in flight, at any stage', () => {
    for (const s of ['pending', 'downloading', 'verifying', 'staging', 'health_check'])
      expect(computeSync(input({ deploymentStatus: s })), s).toBe('deploying');
  });

  it('is deploying when the gateway has never reported this room', () => {
    expect(computeSync(input({ deploymentStatus: 'active', reportedAt: null }))).toBe('deploying');
  });

  it('is failed when the gateway refused the release', () => {
    expect(computeSync(input({ deploymentStatus: 'failed' }))).toBe('failed');
    expect(computeSync(input({ deploymentStatus: 'rolled_back' }))).toBe('failed');
  });

  it('is unreachable when the gateway is offline and the room is not known to be in sync', () => {
    expect(computeSync(input({ gatewayStatus: 'offline' }))).toBe('unreachable');
    expect(computeSync(input({ gatewayStatus: 'pending' }))).toBe('unreachable');
  });

  it('is drifted when a settled deployment is not what the gateway runs', () => {
    expect(computeSync(input({ deploymentStatus: 'active' }))).toBe('drifted');
    expect(computeSync(input({ deploymentStatus: 'active', reportedReleaseId: null, reportedHash: null }))).toBe('drifted');
  });
});

describe('status helpers', () => {
  it('classify statuses', () => {
    expect(isInFlight('staging')).toBe(true);
    expect(isInFlight('active')).toBe(false);
    expect(isInFlight(null)).toBe(false);
    expect(isRefused('rolled_back')).toBe(true);
    expect(isRefused('cancelled')).toBe(false);
    expect(isSettled('superseded')).toBe(true);
    expect(isSettled('scheduled')).toBe(false);
    expect(isSettled('pending')).toBe(false);
  });
});

describe('unpublishedChanges', () => {
  it('is true when the draft is ahead of the latest release', () => {
    expect(unpublishedChanges(5, { draftRevision: 4 })).toBe(true);
    expect(unpublishedChanges(5, { draftRevision: 5 })).toBe(false);
  });
  it('is true when there is a design but no release yet', () => {
    expect(unpublishedChanges(1, null)).toBe(true);
  });
  it('is false with no design, or when the release predates revision tracking', () => {
    expect(unpublishedChanges(null, null)).toBe(false);
    expect(unpublishedChanges(9, { draftRevision: null })).toBe(false);
  });
});
