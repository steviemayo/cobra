import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { after } from 'next/server';
import { db } from '@kestrel/db';
import { MAX_BULK_ROWS, bulkColumns } from '@kestrel/model';
import { writeAudit } from '../audit';
import { getEntitlements } from '../billing';
import { applyBulk, planBulk, type BulkDb, type BulkInput } from '../bulk-rooms';
import { pinDrivers } from '../custom-drivers';
import { syncQuantity } from '../stripe';
import { orgProcedure, requireRole, router } from '../trpc';
import { findTemplateModel } from './room-model-helpers';

const orgId = z.string().uuid();
const rowsInput = z
  .array(
    z.object({
      name: z.string().max(200),
      values: z.record(z.string().max(200), z.string().max(2000)),
    }),
  )
  .max(MAX_BULK_ROWS + 1);

const gridInput = z.object({
  orgId,
  templateId: z.string().min(1),
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid().nullable(),
  rows: rowsInput,
  /** Shared login by device id. */
  credentialSets: z.record(z.string(), z.string().uuid()).default({}),
});

/** What a bulk run needs from the template and the organisation, checked once. */
async function prepare(ctx: { orgId: string; user: { id: string } }, input: z.infer<typeof gridInput>) {
  const site = await db.site.findFirst({ where: { id: input.siteId, orgId: ctx.orgId } });
  if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'Site not found' });
  const model = await findTemplateModel(ctx.orgId, input.templateId);
  const pinned = await pinDrivers(db, ctx.orgId, model);
  const entitlements = await getEntitlements(db, ctx.orgId);
  const bulk: BulkInput = {
    orgId: ctx.orgId,
    siteId: site.id,
    gatewayId: input.gatewayId,
    model,
    custom: pinned.ok ? pinned.drivers : {},
    rows: input.rows,
    credentialSets: input.credentialSets,
    maxRooms: entitlements.maxRooms,
    userId: ctx.user.id,
  };
  return { site, bulk };
}

// Create many rooms from one template, or update the addresses of rooms that already have the
// names in the sheet. Nothing is written unless every row is fine.
export const bulkRouter = router({
  // The columns a template needs, and which devices need a shared login.
  columns: orgProcedure
    .input(z.object({ orgId, templateId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const model = await findTemplateModel(ctx.orgId, input.templateId);
      const pinned = await pinDrivers(db, ctx.orgId, model);
      return { roomType: model.roomType, ...bulkColumns(model, pinned.ok ? pinned.drivers : {}) };
    }),

  preview: orgProcedure.input(gridInput).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const { bulk } = await prepare(ctx, input);
    return planBulk(db as unknown as BulkDb, bulk);
  }),

  create: orgProcedure.input(gridInput).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const { site, bulk } = await prepare(ctx, input);
    const result = await db.$transaction((tx) => applyBulk(tx as unknown as BulkDb, bulk), {
      timeout: 60_000,
    });
    if (!result.ok)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: result.plan.problems[0] ?? 'Fix the problems marked in the sheet first',
      });
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: 'room.bulk_create',
      target: site.id,
      meta: {
        site: site.name,
        template: input.templateId,
        created: result.created.map((r) => r.name),
        updated: result.updated.map((r) => r.name),
      },
    });
    if (result.created.length > 0)
      after(() =>
        syncQuantity(db, ctx.orgId).catch((e) => console.error('[billing] quantity sync failed', e)),
      );
    return { created: result.created, updated: result.updated };
  }),
});
