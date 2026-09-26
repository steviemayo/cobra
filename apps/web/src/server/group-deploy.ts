import type { PanelBranding } from '@kestrel/model';
import { gatewayTooOld, setupProblem } from './deploy-check';
import { createDeployment, type DeploymentDb } from './deployment-service';
import {
  checkPublishable,
  createRelease,
  type Publishable,
  type ReleaseDb,
} from './release-service';
import { GroupError, loadGroup, type GroupDb } from './room-groups';
import type { SigningKey } from './signing';

// Deploying a room group as one action: every room of the group and every combined room gets a
// release of its current design (a new one only if the design changed) and is sent to the gateway.
// Everything is checked first, so a group is never left half deployed because one room's design
// has a problem. Members are deployed before the combined rooms.
export type GroupDeployDb = GroupDb & ReleaseDb & DeploymentDb;

export type GroupDeployAction = 'publish_and_deploy' | 'deploy' | 'up_to_date';

export interface GroupDeployStep {
  roomId: string;
  name: string;
  kind: 'standard' | 'combined';
  action: GroupDeployAction;
  /** The release that will run: the latest one, or the number the new one will get. */
  number: number;
}

export interface GroupDeployPlan {
  /** Why the group cannot be deployed. Empty means it can. */
  problems: string[];
  steps: GroupDeployStep[];
}

interface Work {
  step: GroupDeployStep;
  room: { id: string; name: string; gatewayId: string; panel: unknown };
  checked: Extract<Publishable, { ok: true }>;
  existing: { id: string; number: number } | null;
}

/** What deploying the group would do, room by room, or what stops it. Changes nothing. */
export async function planGroupDeploy(
  db: GroupDeployDb,
  orgId: string,
  groupId: string,
): Promise<{ plan: GroupDeployPlan; work: Work[] }> {
  const view = await loadGroup(db, orgId, groupId);
  if (!view) throw new GroupError('Group not found');
  const problems = [...view.problems];
  if (view.truncated) problems.push('This layout makes too many combined rooms.');
  const missing = view.combined.filter((c) => !c.roomId);
  if (missing.length > 0)
    problems.push(
      `${missing.length} combined room${missing.length === 1 ? ' has' : 's have'} not been created yet. Choose “Update combined rooms” first.`,
    );
  if (problems.length > 0) return { plan: { problems, steps: [] }, work: [] };

  const order = [
    ...view.rooms.map((r) => ({ id: r.id, kind: 'standard' as const })),
    ...view.combined.map((c) => ({ id: c.roomId!, kind: 'combined' as const })),
  ];
  const rows = (await db.room.findMany({
    where: { orgId, id: { in: order.map((o) => o.id) } },
  })) as unknown as {
    id: string;
    name: string;
    gatewayId: string | null;
    panel: unknown;
    desiredReleaseId: string | null;
    reportedReleaseId: string | null;
  }[];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const gateways = new Set(rows.map((r) => r.gatewayId ?? ''));
  if (rows.some((r) => !r.gatewayId))
    problems.push(`“${rows.find((r) => !r.gatewayId)!.name}” is not assigned to a gateway yet.`);
  else if (gateways.size > 1)
    problems.push('Every room in the group must run on the same gateway.');

  const work: Work[] = [];
  for (const o of order) {
    const room = byId.get(o.id);
    if (!room) continue;
    const checked = await checkPublishable(db, orgId, room);
    if (!checked.ok) {
      problems.push(`${room.name}: ${checked.message}`);
      continue;
    }
    const latest = await db.release.findFirst({
      where: { roomId: room.id, orgId },
      orderBy: { number: 'desc' },
    });
    const current = !!latest && latest.draftRevision === checked.draft.revision;
    const running =
      current && room.desiredReleaseId === latest.id && room.reportedReleaseId === latest.id;
    const setup = running ? null : setupProblem(checked.model, checked.bindings, checked.drivers);
    if (setup) {
      problems.push(`${room.name}: ${setup}`);
      continue;
    }
    const tooOld = running || !room.gatewayId ? null : await gatewayTooOld(db, orgId, room.gatewayId, checked.model);
    if (tooOld) {
      problems.push(`${room.name}: ${tooOld}`);
      continue;
    }
    work.push({
      step: {
        roomId: room.id,
        name: room.name,
        kind: o.kind,
        action: running ? 'up_to_date' : current ? 'deploy' : 'publish_and_deploy',
        number: current ? latest.number : (latest?.number ?? 0) + 1,
      },
      room: { id: room.id, name: room.name, gatewayId: room.gatewayId ?? '', panel: room.panel },
      checked,
      existing: current ? { id: latest.id, number: latest.number } : null,
    });
  }
  return {
    plan: { problems, steps: problems.length ? [] : work.map((w) => w.step) },
    work: problems.length ? [] : work,
  };
}

export interface GroupDeployResult {
  roomId: string;
  name: string;
  kind: 'standard' | 'combined';
  number: number;
  published: boolean;
  deployed: boolean;
  deploymentId: string | null;
}

/** Publish (where the design changed) and deploy every room of the group. All or nothing on checks. */
export async function deployGroup(
  db: GroupDeployDb,
  orgId: string,
  groupId: string,
  ctx: { key: SigningKey; orgBranding: PanelBranding; userId: string | null },
): Promise<GroupDeployResult[]> {
  const { plan, work } = await planGroupDeploy(db, orgId, groupId);
  if (plan.problems.length > 0) throw new GroupError(plan.problems[0]!, plan.problems);

  const results: GroupDeployResult[] = [];
  for (const w of work) {
    const base = { roomId: w.room.id, name: w.room.name, kind: w.step.kind };
    if (w.step.action === 'up_to_date') {
      results.push({
        ...base,
        number: w.step.number,
        published: false,
        deployed: false,
        deploymentId: null,
      });
      continue;
    }
    const release =
      w.existing ??
      (await createRelease(db, {
        orgId,
        room: w.room,
        checked: w.checked,
        key: ctx.key,
        orgBranding: ctx.orgBranding,
        userId: ctx.userId,
      }));
    const deployment = await createDeployment(db, {
      orgId,
      roomId: w.room.id,
      gatewayId: w.room.gatewayId,
      releaseId: release.id,
      kind: 'deploy',
      createdBy: ctx.userId,
      scheduledFor: null,
    });
    results.push({
      ...base,
      number: release.number,
      published: !w.existing,
      deployed: true,
      deploymentId: deployment.id,
    });
  }
  return results;
}
