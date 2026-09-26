import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { DeviceCategory, DeviceControl, type CustomDrivers } from '@kestrel/model';
import { writeAudit } from '../audit';
import { pinDrivers } from '../custom-drivers';
import {
  createSiteDevice,
  deleteSiteDevice,
  siteDeviceViews,
  updateSiteDevice,
} from '../site-devices';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const value = z.union([z.string().max(2000), z.number()]);

function fail(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}

/** Custom drivers a shared device may use: looked up by the driver it names. */
async function customFor(ctxOrgId: string, control: unknown): Promise<CustomDrivers> {
  const parsed = DeviceControl.safeParse(control);
  if (!parsed.success || parsed.data.kind !== 'driver' || !parsed.data.driverId.startsWith('custom:')) return {};
  const pinned = await pinDrivers(db, ctxOrgId, {
    devices: [{ id: 'shared', name: 'shared', category: 'audio_matrix', ports: [], extraCapabilities: [], settings: {}, control: parsed.data }],
  } as never);
  return pinned.ok ? pinned.drivers : {};
}

// Shared site devices: one physical device used by several rooms. Logins are write-only, as in a
// room's Setup: a browser only learns whether one is set.
export const siteDeviceRouter = router({
  list: orgProcedure
    .input(z.object({ orgId, siteId: z.string().uuid().optional() }))
    .query(({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      return siteDeviceViews(db, { orgId: ctx.orgId, ...(input.siteId ? { siteId: input.siteId } : {}) });
    }),

  create: orgProcedure
    .input(
      z.object({
        orgId,
        siteId: z.string().uuid(),
        name: z.string().max(200),
        category: DeviceCategory,
        control: DeviceControl,
        exclusive: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const res = await createSiteDevice(db, { ...input, orgId: ctx.orgId, userId: ctx.user.id });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'site_device.create',
        target: res.id,
        meta: { name: input.name, category: input.category },
      });
      return { id: res.id };
    }),

  update: orgProcedure
    .input(
      z.object({
        orgId,
        id: z.string().uuid(),
        name: z.string().max(200).optional(),
        exclusive: z.boolean().optional(),
        set: z.record(z.string().min(1).max(60), value).optional(),
        settings: z.record(z.string().min(1).max(60), value).optional(),
        credentialSetId: z.string().uuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const row = await db.siteDevice.findFirst({ where: { id: input.id, orgId: ctx.orgId } });
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That shared device does not exist' });
      const res = await updateSiteDevice(db, {
        orgId: ctx.orgId,
        id: input.id,
        custom: await customFor(ctx.orgId, row.control),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.exclusive !== undefined ? { exclusive: input.exclusive } : {}),
        ...(input.set ? { set: input.set } : {}),
        ...(input.settings ? { settings: input.settings } : {}),
        ...(input.credentialSetId !== undefined ? { credentialSetId: input.credentialSetId } : {}),
        userId: ctx.user.id,
      });
      if (!res.ok) return fail(res.message);
      // Names only: never the values, which may be logins.
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'site_device.update',
        target: input.id,
        meta: {
          name: row.name,
          changed: [...Object.keys(input.set ?? {}), ...Object.keys(input.settings ?? {})],
          ...(input.exclusive !== undefined ? { exclusive: input.exclusive } : {}),
          ...(input.credentialSetId !== undefined ? { credentialSet: input.credentialSetId } : {}),
        },
      });
      return { version: res.version };
    }),

  delete: orgProcedure.input(z.object({ orgId, id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const row = await db.siteDevice.findFirst({ where: { id: input.id, orgId: ctx.orgId } });
    const res = await deleteSiteDevice(db, ctx.orgId, input.id);
    if (!res.ok) return fail(res.message);
    await writeAudit({ orgId: ctx.orgId, actorId: ctx.user.id, action: 'site_device.delete', target: input.id, meta: { name: row?.name } });
    return { ok: true };
  }),
});
