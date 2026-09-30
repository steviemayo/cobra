import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { AssetCategory, AssetStatus, DeviceControl, DeviceKind } from '@kestrel/model';
import { writeAudit } from '../audit';
import {
  createDevice,
  deleteDevice,
  resolveSwap,
  updateDevice,
  type DeviceInput,
} from '../devices';
import { deviceViews } from '../device-views';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const id = z.string().uuid();
const text = (n: number) => z.string().trim().max(n);
const optText = (n: number) => text(n).nullable().optional();
const date = z.coerce.date().nullable().optional();
const fields = z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()]));

function fail(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}

const patchShape = {
  name: text(80).min(1).optional(),
  category: AssetCategory.optional(),
  roomId: id.nullable().optional(),
  gatewayId: id.nullable().optional(),
  control: DeviceControl.optional(),
  settings: fields.optional(),
  values: fields.optional(),
  secrets: fields.optional(),
  credentialSetId: id.nullable().optional(),
  status: AssetStatus.optional(),
  assetTag: optText(80),
  installedOn: date,
  warrantyEndsOn: date,
  endOfLifeOn: date,
  supplier: optText(200),
  notes: optText(2000),
  make: optText(100),
  model: optText(100),
  serial: optText(100),
  mac: optText(40),
  ip: optText(80),
  firmware: optText(100),
};

// Devices, active and passive (docs/pivot-monitoring.md). Logins are write-only: a browser only
// learns whether one is set.
export const deviceRouter = router({
  list: orgProcedure
    .input(z.object({ orgId, siteId: id.optional(), roomId: id.optional(), areaId: id.optional() }))
    .query(({ ctx, input }) => deviceViews(db, { ...input, orgId: ctx.orgId })),

  get: orgProcedure.input(z.object({ orgId, deviceId: id })).query(async ({ ctx, input }) => {
    const [view] = await deviceViews(db, { orgId: ctx.orgId, deviceId: input.deviceId });
    if (!view) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such device' });
    return view;
  }),

  /** The device's history, newest first. */
  events: orgProcedure
    .input(z.object({ orgId, deviceId: id, limit: z.number().int().min(1).max(500).default(100) }))
    .query(async ({ ctx, input }) => {
      const device = await db.device.findFirst({ where: { id: input.deviceId, orgId: ctx.orgId } });
      if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such device' });
      return db.deviceEvent.findMany({
        where: { deviceId: input.deviceId, orgId: ctx.orgId },
        orderBy: { at: 'desc' },
        take: input.limit,
      });
    }),

  create: orgProcedure
    .input(
      z.object({
        ...patchShape,
        orgId,
        siteId: id,
        kind: DeviceKind,
        name: text(80).min(1),
        category: AssetCategory,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const res = await createDevice(db, {
        ...(input as unknown as DeviceInput),
        orgId: ctx.orgId,
        siteId: input.siteId,
        kind: input.kind,
        name: input.name,
        category: input.category,
        actorId: ctx.user.id,
      });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'device.create',
        target: res.value.id,
        meta: { name: input.name, kind: input.kind, category: input.category },
      });
      return res.value;
    }),

  update: orgProcedure
    .input(z.object({ ...patchShape, orgId, deviceId: id }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const { deviceId, ...withOrg } = input;
      const patch: Record<string, unknown> = { ...withOrg };
      delete patch.orgId;
      const res = await updateDevice(db, {
        orgId: ctx.orgId,
        deviceId,
        actorId: ctx.user.id,
        patch: patch as unknown as DeviceInput,
      });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'device.update',
        target: deviceId,
      });
      return res.value;
    }),

  /** "The serial changed": replaced (the old identity is retired) or a correction (no swap). */
  resolveSwap: orgProcedure
    .input(
      z.object({
        orgId,
        deviceId: id,
        outcome: z.enum(['replaced', 'correction']),
        note: text(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const res = await resolveSwap(db, {
        orgId: ctx.orgId,
        deviceId: input.deviceId,
        outcome: input.outcome,
        actorId: ctx.user.id,
        note: input.note,
      });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: `device.swap_${input.outcome}`,
        target: input.deviceId,
      });
      return res.value;
    }),

  delete: orgProcedure.input(z.object({ orgId, deviceId: id })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const res = await deleteDevice(db, ctx.orgId, input.deviceId);
    if (!res.ok) return fail(res.message);
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: 'device.delete',
      target: input.deviceId,
    });
    return res.value;
  }),
});
