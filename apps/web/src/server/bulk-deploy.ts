import type { PanelBranding } from '@kestrel/model';
import { checkDeployable, type DeployCheckDb } from './deploy-check';
import { createDeployment } from './deployment-service';
import { IN_FLIGHT } from './drift';
import { planRoomDeploy, type GroupDeployDb, type PlanRoom, type Work } from './group-deploy';
import { createRelease } from './release-service';
import type { SigningKey } from './signing';

// Deploying or rolling back many rooms at once, chosen by hand. Unlike a room group, the rooms are
// independent: one room with a problem is reported and skipped, and the rest still go. A staged
// rollout is done by choosing a few rooms first ("canary") and the rest after they are running.
// Everything is planned first without changing anything, so the dialog can show what would happen.
export type BulkDeployDb = GroupDeployDb & DeployCheckDb;

export const MAX_BULK_DEPLOY_ROOMS = 100;

export type BulkMode = 'deploy' | 'rollback';
export type BulkAction =
  | 'publish_and_deploy'
  | 'deploy'
  | 'rollback'
  | 'up_to_date'
  | 'in_progress';

export interface BulkStep {
  roomId: string;
  name: string;
  action: BulkAction;
  /** The release that will run. */
  number: number;
  /** The release the room is set to run now, when there is one. */
  from: number | null;
}

export interface BulkBlocked {
  roomId: string;
  name: string;
  message: string;
}

export interface BulkPlan {
  steps: BulkStep[];
  blocked: BulkBlocked[];
}

interface Item {
  step: BulkStep;
  gatewayId: string;
  /** Deploy: the room's work, which may need a new release first. */
  work?: Work;
  /** Rollback: the earlier release to go back to. */
  rollbackTo?: string;
}

export class BulkDeployError extends Error {}

/** What each chosen room would do, or why it cannot. Changes nothing. */
export async function planBulkDeploy(
  db: BulkDeployDb,
  orgId: string,
  roomIds: string[],
  mode: BulkMode,
): Promise<{ plan: BulkPlan; items: Item[] }> {
  const ids = [...new Set(roomIds)];
  if (ids.length === 0) throw new BulkDeployError('Choose at least one room.');
  if (ids.length > MAX_BULK_DEPLOY_ROOMS)
    throw new BulkDeployError(`Choose up to ${MAX_BULK_DEPLOY_ROOMS} rooms at a time.`);

  const rows = (await db.room.findMany({ where: { orgId, id: { in: ids } } })) as unknown as PlanRoom[];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const items: Item[] = [];
  const blocked: BulkBlocked[] = [];
  for (const id of ids) {
    const room = byId.get(id);
    if (!room) {
      blocked.push({ roomId: id, name: 'Unknown room', message: 'This room was not found.' });
      continue;
    }
    if (!room.gatewayId) {
      blocked.push({ roomId: id, name: room.name, message: 'Not assigned to a gateway yet.' });
      continue;
    }
    const planned =
      mode === 'deploy'
        ? await planDeploy(db, orgId, room, room.gatewayId)
        : await planRollback(db, orgId, room, room.gatewayId);
    if ('problem' in planned) blocked.push({ roomId: id, name: room.name, message: planned.problem });
    else items.push(planned.item);
  }
  return { plan: { steps: items.map((i) => i.step), blocked }, items };
}

async function planDeploy(
  db: BulkDeployDb,
  orgId: string,
  room: PlanRoom,
  gatewayId: string,
): Promise<{ problem: string } | { item: Item }> {
  const planned = await planRoomDeploy(db, orgId, room, 'standard');
  if ('problem' in planned) return planned;
  const { work } = planned;
  const from = await releaseNumber(db, orgId, room.desiredReleaseId);
  const base = { roomId: room.id, name: room.name, number: work.step.number, from };
  if (work.step.action === 'up_to_date')
    return { item: { step: { ...base, action: 'up_to_date' }, gatewayId, work } };
  if (work.existing) {
    // Sent already and still on its way: sending it again would restart it.
    if (await inFlight(db, room.id, work.existing.id))
      return { item: { step: { ...base, action: 'in_progress' }, gatewayId, work } };
    const ready = await checkDeployable(db, { orgId, roomId: room.id, gatewayId, releaseId: work.existing.id });
    if (!ready.ok) return { problem: ready.message };
  }
  return {
    item: {
      step: { ...base, action: work.existing ? 'deploy' : 'publish_and_deploy' },
      gatewayId,
      work,
    },
  };
}

async function planRollback(
  db: BulkDeployDb,
  orgId: string,
  room: PlanRoom,
  gatewayId: string,
): Promise<{ problem: string } | { item: Item }> {
  if (!room.desiredReleaseId) return { problem: 'Nothing has been deployed to this room yet.' };
  const current = await db.release.findFirst({ where: { id: room.desiredReleaseId, orgId } });
  if (!current) return { problem: 'The release this room runs could not be found.' };
  const previous = await db.release.findFirst({
    where: { roomId: room.id, orgId, number: { lt: current.number } },
    orderBy: { number: 'desc' },
  });
  if (!previous) return { problem: 'There is no earlier release to go back to.' };
  const step = {
    roomId: room.id,
    name: room.name,
    number: previous.number,
    from: current.number,
  };
  if (await inFlight(db, room.id, previous.id))
    return { item: { step: { ...step, action: 'in_progress' }, gatewayId } };
  const ready = await checkDeployable(db, { orgId, roomId: room.id, gatewayId, releaseId: previous.id });
  if (!ready.ok) return { problem: ready.message };
  return { item: { step: { ...step, action: 'rollback' }, gatewayId, rollbackTo: previous.id } };
}

async function releaseNumber(db: BulkDeployDb, orgId: string, id: string | null) {
  if (!id) return null;
  const r = await db.release.findFirst({ where: { id, orgId } });
  return r?.number ?? null;
}

async function inFlight(db: BulkDeployDb, roomId: string, releaseId: string) {
  const dep = await db.deployment.findFirst({
    where: { roomId, releaseId, status: { in: [...IN_FLIGHT] } },
  });
  return !!dep;
}

export interface BulkResult {
  roomId: string;
  name: string;
  number: number;
  published: boolean;
  deploymentId: string;
  kind: BulkMode;
}

/** Publish (where the design changed) and deploy, or roll back, every chosen room that is ready. */
export async function deployBulk(
  db: BulkDeployDb,
  orgId: string,
  roomIds: string[],
  mode: BulkMode,
  ctx: { key: SigningKey; orgBranding: PanelBranding; userId: string | null },
): Promise<{ results: BulkResult[]; skipped: BulkStep[]; blocked: BulkBlocked[] }> {
  const { plan, items } = await planBulkDeploy(db, orgId, roomIds, mode);
  const results: BulkResult[] = [];
  const skipped: BulkStep[] = [];
  for (const item of items) {
    const { step } = item;
    if (step.action === 'up_to_date' || step.action === 'in_progress') {
      skipped.push(step);
      continue;
    }
    let releaseId: string;
    let published = false;
    if (item.rollbackTo) releaseId = item.rollbackTo;
    else if (item.work!.existing) releaseId = item.work!.existing.id;
    else {
      const w = item.work!;
      const release = await createRelease(db, {
        orgId,
        room: w.room,
        checked: w.checked,
        key: ctx.key,
        orgBranding: ctx.orgBranding,
        userId: ctx.userId,
      });
      releaseId = release.id;
      published = true;
    }
    const deployment = await createDeployment(db, {
      orgId,
      roomId: step.roomId,
      gatewayId: item.gatewayId,
      releaseId,
      kind: mode,
      createdBy: ctx.userId,
      scheduledFor: null,
    });
    results.push({
      roomId: step.roomId,
      name: step.name,
      number: step.number,
      published,
      deploymentId: deployment.id,
      kind: mode,
    });
  }
  return { results, skipped, blocked: plan.blocked };
}
