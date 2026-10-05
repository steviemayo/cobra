import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import {
  DriverRequestInput,
  DriverSetting,
  assetCategoryLabel,
  checkDriverSpec,
} from '@kestrel/model';
import { writeAudit } from '../audit';
import { saveDriver } from '../custom-drivers';
import { DriverRequestError, createDriverRequest, requestsForOrg } from '../driver-requests';
import { findDriverUpdates } from '../driver-updates';
import { featureProcedure, orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const proProcedure = featureProcedure('driverCreate');

export const driverRouter = router({
  // Names and the settings each driver reads, for the device picker and its fields: available to
  // anyone who can design a room.
  options: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    const rows = await db.customDriver.findMany({ where: { orgId: ctx.orgId }, orderBy: { name: 'asc' } });
    const versions = rows.length
      ? await db.customDriverVersion.findMany({
          where: { OR: rows.map((d) => ({ driverId: d.id, version: d.latestVersion })) },
        })
      : [];
    return rows.map((d) => {
      const spec = versions.find((v) => v.driverId === d.id && v.version === d.latestVersion)?.spec;
      const raw = (spec ?? {}) as { settings?: unknown; make?: string; model?: string; categories?: string[] };
      const settings = DriverSetting.array().safeParse(raw.settings);
      const categories = raw.categories ?? [];
      // Same shape as the built-in labels: Category – Make Model. A driver with no category is offered everywhere.
      const kind = categories.length === 1 ? assetCategoryLabel(categories[0]!) : 'Custom';
      const who = [raw.make, raw.model].filter(Boolean).join(' ');
      return {
        id: `custom:${d.slug}`,
        name: d.name,
        label: `${kind} – ${who || d.name}`,
        make: raw.make ?? null,
        model: raw.model ?? null,
        categories,
        latestVersion: d.latestVersion,
        settings: settings.success ? settings.data : [],
      };
    });
  }),

  // Asking Kestrel for a driver. Open to every plan: it feeds the roadmap, and it only raises a ticket.
  requests: router({
    list: orgProcedure.input(z.object({ orgId })).query(({ ctx }) => requestsForOrg(db, ctx.orgId)),

    create: orgProcedure
      .input(z.object({ orgId, request: DriverRequestInput }))
      .mutation(async ({ ctx, input }) => {
        requireRole(ctx.role, ['owner', 'dev', 'support']);
        try {
          const res = await createDriverRequest(db, {
            orgId: ctx.orgId,
            by: { id: ctx.user.id, email: ctx.user.email ?? null },
            request: input.request,
          });
          await writeAudit({
            orgId: ctx.orgId,
            actorId: ctx.user.id,
            action: 'driver.request',
            target: res.id,
            meta: { make: input.request.make, model: input.request.model },
          });
          return res;
        } catch (e) {
          if (e instanceof DriverRequestError)
            throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
          throw e;
        }
      }),
  }),

  // Rooms running an older version of one of the organisation's drivers than the latest, so they
  // can be updated together. Not shown to a provider limited to some sites (it covers everything).
  updates: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    return findDriverUpdates(db, ctx.orgId);
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
