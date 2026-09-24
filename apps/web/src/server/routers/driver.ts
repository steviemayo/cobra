import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { checkDriverSpec } from '@kestrel/model';
import { writeAudit } from '../audit';
import { saveDriver } from '../custom-drivers';
import { featureProcedure, orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const proProcedure = featureProcedure('driverCreate');

export const driverRouter = router({
  // Names only, for the device picker: available to anyone who can design a room.
  options: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    const rows = await db.customDriver.findMany({ where: { orgId: ctx.orgId }, orderBy: { name: 'asc' } });
    return rows.map((d) => ({ id: `custom:${d.slug}`, name: d.name, latestVersion: d.latestVersion }));
  }),

  list: proProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const rows = await db.customDriver.findMany({ where: { orgId: ctx.orgId }, orderBy: { name: 'asc' } });
    return rows.map((d) => ({ id: d.id, slug: d.slug, name: d.name, latestVersion: d.latestVersion }));
  }),

  get: proProcedure
    .input(z.object({ orgId, driverId: z.string().uuid(), version: z.number().int().min(1).optional() }))
    .query(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const d = await db.customDriver.findFirst({ where: { id: input.driverId, orgId: ctx.orgId } });
      if (!d) throw new TRPCError({ code: 'NOT_FOUND', message: 'Driver not found' });
      const v = await db.customDriverVersion.findFirst({ where: { driverId: d.id, version: input.version ?? d.latestVersion } });
      return { id: d.id, slug: d.slug, name: d.name, latestVersion: d.latestVersion, version: v?.version ?? d.latestVersion, spec: v?.spec ?? null };
    }),

  // Checks without saving, so the editor can show problems as you type.
  check: proProcedure.input(z.object({ orgId, spec: z.unknown() })).mutation(({ input }) => {
    const r = checkDriverSpec(input.spec);
    return r.ok ? { ok: true as const, problems: [] as string[] } : { ok: false as const, problems: r.problems };
  }),

  save: proProcedure.input(z.object({ orgId, spec: z.unknown() })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const res = await saveDriver(db, { orgId: ctx.orgId, raw: input.spec, by: ctx.user.id });
    if (!res.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: res.problems.slice(0, 3).join('. ') });
    await writeAudit({ orgId: ctx.orgId, actorId: ctx.user.id, action: 'driver.save', target: res.id, meta: { version: res.version, created: res.created } });
    return { id: res.id, version: res.version, created: res.created };
  }),

  delete: proProcedure.input(z.object({ orgId, driverId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const d = await db.customDriver.findFirst({ where: { id: input.driverId, orgId: ctx.orgId } });
    if (!d) throw new TRPCError({ code: 'NOT_FOUND', message: 'Driver not found' });
    // Releases carry their own copy, so rooms already running are not affected.
    await db.customDriver.delete({ where: { id: d.id } });
    await writeAudit({ orgId: ctx.orgId, actorId: ctx.user.id, action: 'driver.delete', target: d.id, meta: { name: d.name } });
    return { ok: true };
  }),
});
