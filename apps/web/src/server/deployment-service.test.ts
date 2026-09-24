import { describe, expect, it } from 'vitest';
import type { DeploymentReport } from '@kestrel/model';
import {
  applyReport,
  cancelScheduled,
  createDeployment,
  promoteDue,
  type DeploymentDb,
  type NewDeployment,
} from './deployment-service';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '11111111-1111-4111-8111-111111111112';
const GW = '99999999-9999-4999-8999-999999999991';
const GW2 = '99999999-9999-4999-8999-999999999992';
const ROOM = '33333333-3333-4333-8333-333333333331';
const ROOM2 = '33333333-3333-4333-8333-333333333332';
const REL1 = '44444444-4444-4444-8444-444444444441';
const REL2 = '44444444-4444-4444-8444-444444444442';
const NOW = new Date('2026-09-24T10:00:00Z');
const at = (mins: number) => new Date(NOW.getTime() + mins * 60_000);

function world() {
  const room = table([
    { id: ROOM, orgId: ORG, gatewayId: GW, desiredReleaseId: null, desiredDeploymentId: null },
    { id: ROOM2, orgId: ORG, gatewayId: GW2, desiredReleaseId: null, desiredDeploymentId: null },
  ]);
  const deployment = table([]);
  const deploymentEvent = table([], ['deploymentId', 'stage']);
  const db = { room, deployment, deploymentEvent } as unknown as DeploymentDb;
  const get = (id: string) => deployment.rows.find((d) => d.id === id)!;
  return { db, room, deployment, deploymentEvent, get };
}

const spec = (over: Partial<NewDeployment> = {}): NewDeployment => ({
  orgId: ORG,
  roomId: ROOM,
  gatewayId: GW,
  releaseId: REL1,
  kind: 'deploy',
  createdBy: null,
  scheduledFor: null,
  ...over,
});

const report = (id: string, stages: string[], error?: string): DeploymentReport => ({
  deploymentId: id,
  stage: stages.at(-1) as DeploymentReport['stage'],
  history: stages.map((stage, i) => ({ stage: stage as DeploymentReport['stage'], at: at(i).toISOString() })),
  ...(error ? { error } : {}),
});

describe('createDeployment', () => {
  it('starts now: the deployment is pending and becomes what the room should run', async () => {
    const w = world();
    const d = await createDeployment(w.db, spec(), NOW);
    expect(d).toMatchObject({ status: 'pending', releaseId: REL1, gatewayId: GW });
    expect(w.room.rows[0]).toMatchObject({ desiredReleaseId: REL1, desiredDeploymentId: d.id });
  });

  it('replaces an older deployment that is still under way', async () => {
    const w = world();
    const first = await createDeployment(w.db, spec(), NOW);
    const second = await createDeployment(w.db, spec({ releaseId: REL2 }), at(1));
    expect(w.get(first.id)).toMatchObject({ status: 'superseded', finishedAt: at(1) });
    expect(w.get(second.id).status).toBe('pending');
    expect(w.room.rows[0]).toMatchObject({ desiredReleaseId: REL2, desiredDeploymentId: second.id });
  });

  it('leaves settled history alone', async () => {
    const w = world();
    const first = await createDeployment(w.db, spec(), NOW);
    w.get(first.id).status = 'active';
    await createDeployment(w.db, spec({ releaseId: REL2 }), at(1));
    expect(w.get(first.id).status).toBe('active');
  });

  it('a future time is only scheduled: the room is untouched until then', async () => {
    const w = world();
    const d = await createDeployment(w.db, spec({ scheduledFor: at(30) }), NOW);
    expect(d).toMatchObject({ status: 'scheduled', scheduledFor: at(30) });
    expect(w.room.rows[0]).toMatchObject({ desiredReleaseId: null, desiredDeploymentId: null });
  });

  it('a scheduled time that has already passed starts straight away', async () => {
    const w = world();
    const d = await createDeployment(w.db, spec({ scheduledFor: at(-5) }), NOW);
    expect(d.status).toBe('pending');
  });

  it('does not disturb a scheduled deployment when another starts now', async () => {
    const w = world();
    const later = await createDeployment(w.db, spec({ scheduledFor: at(30) }), NOW);
    await createDeployment(w.db, spec({ releaseId: REL2 }), NOW);
    expect(w.get(later.id).status).toBe('scheduled');
  });
});

describe('promoteDue', () => {
  it('starts a scheduled deployment once its time has come', async () => {
    const w = world();
    const d = await createDeployment(w.db, spec({ scheduledFor: at(30) }), NOW);
    expect(await promoteDue(w.db, GW, at(29))).toBe(0);
    expect(w.get(d.id).status).toBe('scheduled');
    expect(await promoteDue(w.db, GW, at(30))).toBe(1);
    expect(w.get(d.id).status).toBe('pending');
    expect(w.room.rows[0]).toMatchObject({ desiredReleaseId: REL1, desiredDeploymentId: d.id });
  });

  it('only touches rooms on the gateway that is checking in', async () => {
    const w = world();
    const other = await createDeployment(w.db, spec({ roomId: ROOM2, gatewayId: GW2, scheduledFor: at(30) }), NOW);
    expect(await promoteDue(w.db, GW, at(60))).toBe(0);
    expect(w.get(other.id).status).toBe('scheduled');
  });

  it('does not start a cancelled deployment', async () => {
    const w = world();
    const d = await createDeployment(w.db, spec({ scheduledFor: at(30) }), NOW);
    await cancelScheduled(w.db, ORG, d.id, at(1));
    expect(await promoteDue(w.db, GW, at(60))).toBe(0);
    expect(w.room.rows[0]!.desiredReleaseId).toBeNull();
  });

  it('when several are due for one room, the latest wins and the rest are replaced', async () => {
    const w = world();
    const a = await createDeployment(w.db, spec({ scheduledFor: at(10) }), NOW);
    const b = await createDeployment(w.db, spec({ releaseId: REL2, scheduledFor: at(20) }), NOW);
    expect(await promoteDue(w.db, GW, at(30))).toBe(2);
    expect(w.get(a.id).status).toBe('superseded');
    expect(w.get(b.id).status).toBe('pending');
    expect(w.room.rows[0]).toMatchObject({ desiredReleaseId: REL2, desiredDeploymentId: b.id });
  });

  it('replaces a deployment already under way', async () => {
    const w = world();
    const running = await createDeployment(w.db, spec(), NOW);
    const due = await createDeployment(w.db, spec({ releaseId: REL2, scheduledFor: at(10) }), NOW);
    await promoteDue(w.db, GW, at(11));
    expect(w.get(running.id).status).toBe('superseded');
    expect(w.get(due.id).status).toBe('pending');
  });
});

describe('cancelScheduled', () => {
  it('cancels a scheduled deployment, once', async () => {
    const w = world();
    const d = await createDeployment(w.db, spec({ scheduledFor: at(30) }), NOW);
    expect(await cancelScheduled(w.db, ORG, d.id, at(1))).toBe(true);
    expect(w.get(d.id)).toMatchObject({ status: 'cancelled', finishedAt: at(1) });
    expect(await cancelScheduled(w.db, ORG, d.id, at(2))).toBe(false);
  });

  it('cannot cancel one that has started, or one in another org', async () => {
    const w = world();
    const started = await createDeployment(w.db, spec(), NOW);
    expect(await cancelScheduled(w.db, ORG, started.id)).toBe(false);
    const d = await createDeployment(w.db, spec({ scheduledFor: at(30) }), NOW);
    expect(await cancelScheduled(w.db, OTHER_ORG, d.id)).toBe(false);
    expect(w.get(d.id).status).toBe('scheduled');
  });
});

describe('applyReport', () => {
  it('follows the gateway through the stages, keeping its timeline', async () => {
    const w = world();
    const d = await createDeployment(w.db, spec(), NOW);
    await applyReport(w.db, ORG, ROOM, report(d.id, ['downloading', 'verifying']), at(1));
    expect(w.get(d.id)).toMatchObject({ status: 'verifying', startedAt: at(0), finishedAt: null });

    await applyReport(w.db, ORG, ROOM, report(d.id, ['downloading', 'verifying', 'staging', 'health_check', 'active']), at(5));
    expect(w.get(d.id)).toMatchObject({ status: 'active', startedAt: at(0), finishedAt: at(5), error: null });
    expect(w.deploymentEvent.rows.map((e) => e.stage)).toEqual([
      'downloading',
      'verifying',
      'staging',
      'health_check',
      'active',
    ]);
  });

  it('does not repeat a stage it already has when the same report arrives again', async () => {
    const w = world();
    const d = await createDeployment(w.db, spec(), NOW);
    const r = report(d.id, ['downloading', 'verifying']);
    await applyReport(w.db, ORG, ROOM, r, at(1));
    await applyReport(w.db, ORG, ROOM, r, at(2));
    expect(w.deploymentEvent.rows).toHaveLength(2);
  });

  it('records a refusal with the reason', async () => {
    const w = world();
    const d = await createDeployment(w.db, spec(), NOW);
    await applyReport(
      w.db,
      ORG,
      ROOM,
      report(d.id, ['downloading', 'verifying', 'staging', 'health_check', 'rolled_back'], 'could not reach DSP'),
      at(3),
    );
    expect(w.get(d.id)).toMatchObject({ status: 'rolled_back', error: 'could not reach DSP', finishedAt: at(3) });
  });

  it('never reopens a deployment that has settled', async () => {
    const w = world();
    const d = await createDeployment(w.db, spec(), NOW);
    await applyReport(w.db, ORG, ROOM, report(d.id, ['downloading', 'active']), at(1));
    await applyReport(w.db, ORG, ROOM, report(d.id, ['downloading']), at(2));
    expect(w.get(d.id).status).toBe('active');
  });

  it('ignores a report for a deployment that was replaced or cancelled', async () => {
    const w = world();
    const old = await createDeployment(w.db, spec(), NOW);
    await createDeployment(w.db, spec({ releaseId: REL2 }), at(1));
    await applyReport(w.db, ORG, ROOM, report(old.id, ['downloading', 'active']), at(2));
    expect(w.get(old.id).status).toBe('superseded');
    expect(w.deploymentEvent.rows).toHaveLength(0);
  });

  it('ignores unknown deployments, other rooms and other orgs', async () => {
    const w = world();
    const d = await createDeployment(w.db, spec(), NOW);
    await applyReport(w.db, ORG, ROOM, report('99999999-0000-4000-8000-000000000000', ['active']), at(1));
    await applyReport(w.db, ORG, ROOM2, report(d.id, ['active']), at(1));
    await applyReport(w.db, OTHER_ORG, ROOM, report(d.id, ['active']), at(1));
    expect(w.get(d.id).status).toBe('pending');
  });

  it('does not trust a gateway clock that is far in the future', async () => {
    const w = world();
    const d = await createDeployment(w.db, spec(), NOW);
    const r = report(d.id, ['downloading']);
    r.history[0]!.at = '2099-01-01T00:00:00.000Z';
    await applyReport(w.db, ORG, ROOM, r, NOW);
    expect((w.deploymentEvent.rows[0]!.at as Date).getTime()).toBeLessThanOrEqual(NOW.getTime() + 60_000);
  });
});
