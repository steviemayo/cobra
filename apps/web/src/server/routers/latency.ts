import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { writeAudit } from '../audit';
import {
  LATENCY_DEFAULTS,
  latencyLimits,
  latencySeries,
  latencySummary,
  resetLatencyLimits,
  saveLatencyLimits,
  worstDevices,
} from '../latency';
import { SITE_SCOPED, inScope, siteFilter } from '../site-scope';
import { featureProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const range = z.enum(['24h', '7d', '30d']).default('24h');
const monitoringProcedure = featureProcedure('monitoring');

// Response times (docs/decisions.md RT-1..): how long devices take to answer the gateway's pings, as
// a measure of the network between them. Read only, except an organisation's own limits.
export const latencyRouter = router({
  // One device's graph and how the last day compares with its usual.
  device: monitoringProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, deviceId: z.string().uuid(), range }))
    .query(async ({ ctx, input }) => {
      const device = await db.device.findFirst({
        where: { id: input.deviceId, orgId: ctx.orgId, ...siteFilter(ctx.siteScope) },
      });
      if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });
      const where = { deviceId: device.id };
      const [points, summary] = await Promise.all([
        latencySeries(db, ctx.orgId, where, input.range),
        latencySummary(db, ctx.orgId, where),
      ]);
      return { points, summary };
    }),

  // A site's network: every device's answers together, and the devices doing worst.
  site: monitoringProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, siteId: z.string().uuid(), range }))
    .query(async ({ ctx, input }) => {
      if (!inScope(ctx.siteScope, input.siteId))
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Site not found' });
      const site = await db.site.findFirst({ where: { id: input.siteId, orgId: ctx.orgId } });
      if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'Site not found' });
      const where = { siteId: site.id };
      const [points, summary, worst] = await Promise.all([
        latencySeries(db, ctx.orgId, where, input.range),
        latencySummary(db, ctx.orgId, where),
        worstDevices(db, ctx.orgId, site.id),
      ]);
      return { points, summary, worst };
    }),

  // Each site's last day, for the overview.
  sites: monitoringProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId }))
    .query(async ({ ctx }) => {
      const sites = await db.site.findMany({
        where: { orgId: ctx.orgId, ...(ctx.siteScope ? { id: { in: ctx.siteScope } } : {}) },
        orderBy: { name: 'asc' },
      });
      return Promise.all(
        sites.map(async (s) => ({
          siteId: s.id,
          name: s.name,
          ...(await latencySummary(db, ctx.orgId, { siteId: s.id })),
        })),
      );
    }),

  limits: monitoringProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId }))
    .query(async ({ ctx }) => ({
      ...(await latencyLimits(db, ctx.orgId)),
      defaults: LATENCY_DEFAULTS,
    })),

  saveLimits: monitoringProcedure
    .input(
      z.object({
        orgId,
        factor: z.number().min(1.2).max(20),
        minIncreaseMs: z.number().min(1).max(1000),
        highMs: z.number().min(10).max(5000),
        lossPercent: z.number().min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const limits = {
        factor: input.factor,
        minIncreaseMs: input.minIncreaseMs,
        highMs: input.highMs,
        lossPercent: input.lossPercent,
      };
      await saveLatencyLimits(db, ctx.orgId, limits);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'latency.limits',
        target: ctx.orgId,
        meta: limits,
      });
      return { ok: true };
    }),

  resetLimits: monitoringProcedure.input(z.object({ orgId })).mutation(async ({ ctx }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    await resetLatencyLimits(db, ctx.orgId);
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: 'latency.reset',
      target: ctx.orgId,
    });
    return { ok: true };
  }),
});
