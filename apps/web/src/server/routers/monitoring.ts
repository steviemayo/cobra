import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { after } from 'next/server';
import { db } from '@kestrel/db';
import { DeviceFeedback } from '@kestrel/model';
import { deliverAlerts } from '../alerts';
import { writeAudit } from '../audit';
import { firmwareReport } from '../firmware-report';
import { maybeSweep } from '../monitoring';
import { orgOverview } from '../monitoring-queries';
import { SITE_SCOPED, siteFilter, type SiteScope } from '../site-scope';
import { featureProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const monitoringProcedure = featureProcedure('monitoring');

/**
 * For a site-limited provider: which incidents it may see, as a Prisma OR list (an incident is
 * about a room at its sites, or about a gateway at its sites). null: no limit.
 */
async function incidentScope(orgId: string, scope: SiteScope) {
  if (scope === null) return null;
  const [rooms, gateways] = await Promise.all([
    db.room.findMany({ where: { orgId, ...siteFilter(scope) }, select: { id: true } }),
    db.gateway.findMany({ where: { orgId, ...siteFilter(scope) }, select: { id: true } }),
  ]);
  return [
    { roomId: { in: rooms.map((r) => r.id) } },
    { roomId: null, gatewayId: { in: gateways.map((g) => g.id) } },
  ];
}

export const monitoringRouter = router({
  // Polled by the live status pages. Also sweeps for silent gateways, since nothing else runs then.
  overview: monitoringProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId }))
    .query(async ({ ctx }) => {
      const jobs = await maybeSweep(db);
      if (jobs.length) after(() => deliverAlerts(db, jobs));
      return orgOverview(db, ctx.orgId, new Date(), ctx.siteScope);
    }),

  room: monitoringProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, roomId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const room = await db.room.findFirst({
        where: { id: input.roomId, orgId: ctx.orgId, ...siteFilter(ctx.siteScope) },
      });
      if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found' });
      const [devices, incidents, events] = await Promise.all([
        db.deviceStatus.findMany({
          where: { roomId: room.id, orgId: ctx.orgId },
          orderBy: { name: 'asc' },
        }),
        db.incident.findMany({
          where: { roomId: room.id, orgId: ctx.orgId },
          orderBy: { openedAt: 'desc' },
          take: 20,
        }),
        db.gatewayEvent.findMany({
          where: { roomId: room.id, orgId: ctx.orgId },
          orderBy: { at: 'desc' },
          take: 40,
          select: { id: true, type: true, at: true, data: true },
        }),
      ]);
      return {
        devices: devices.map((d) => ({
          deviceId: d.deviceId,
          name: d.name,
          online: d.online,
          since: d.since,
          driver: d.driver ?? null,
          firmware: d.firmware ?? null,
          // Stored loosely (Json); parsed here so an old row from before this field existed, or
          // anything unexpected, can't reach the page as something the UI doesn't understand.
          feedback: DeviceFeedback.safeParse(d.feedback ?? {}).data ?? null,
        })),
        incidents,
        events: events.map((e) => ({ ...e, data: (e.data ?? {}) as Record<string, unknown> })),
      };
    }),

  // The firmware each device reports, across the estate. Read only.
  firmware: monitoringProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId }))
    .query(({ ctx }) => firmwareReport(db, ctx.orgId, ctx.siteScope)),

  incidents: monitoringProcedure
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId,
        status: z.enum(['open', 'resolved', 'all']).default('open'),
        limit: z.number().int().min(1).max(200).default(100),
      }),
    )
    .query(async ({ ctx, input }) => {
      const scoped = await incidentScope(ctx.orgId, ctx.siteScope);
      const rows = await db.incident.findMany({
        where: {
          orgId: ctx.orgId,
          ...(input.status === 'all' ? {} : { status: input.status }),
          ...(scoped ? { OR: scoped } : {}),
        },
        orderBy: { openedAt: 'desc' },
        take: input.limit,
      });
      const rooms = await db.room.findMany({
        where: {
          orgId: ctx.orgId,
          id: { in: [...new Set(rows.flatMap((r) => (r.roomId ? [r.roomId] : [])))] },
        },
        select: { id: true, name: true },
      });
      const roomName = new Map(rooms.map((r) => [r.id, r.name]));
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        severity: r.severity,
        status: r.status,
        title: r.title,
        detail: r.detail,
        roomId: r.roomId,
        roomName: r.roomId ? (roomName.get(r.roomId) ?? null) : null,
        openedAt: r.openedAt,
        resolvedAt: r.resolvedAt,
        occurrences: r.occurrences,
        acknowledged: r.acknowledgedAt !== null,
      }));
    }),

  acknowledge: monitoringProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, incidentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const scoped = await incidentScope(ctx.orgId, ctx.siteScope);
      const { count } = await db.incident.updateMany({
        where: {
          id: input.incidentId,
          orgId: ctx.orgId,
          acknowledgedAt: null,
          ...(scoped ? { OR: scoped } : {}),
        },
        data: { acknowledgedBy: ctx.user.id, acknowledgedAt: new Date() },
      });
      if (count > 0)
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'incident.acknowledge',
          target: input.incidentId,
        });
      return { ok: true };
    }),
});
