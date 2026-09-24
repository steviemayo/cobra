import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { after } from 'next/server';
import { db } from '@kestrel/db';
import { deliverAlerts } from '../alerts';
import { writeAudit } from '../audit';
import { maybeSweep } from '../monitoring';
import { orgOverview } from '../monitoring-queries';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();

export const monitoringRouter = router({
  // Polled by the live status pages. Also sweeps for silent gateways, since nothing else runs then.
  overview: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    const jobs = await maybeSweep(db);
    if (jobs.length) after(() => deliverAlerts(db, jobs));
    return orgOverview(db, ctx.orgId);
  }),

  room: orgProcedure
    .input(z.object({ orgId, roomId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const room = await db.room.findFirst({ where: { id: input.roomId, orgId: ctx.orgId } });
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
        })),
        incidents,
        events: events.map((e) => ({ ...e, data: (e.data ?? {}) as Record<string, unknown> })),
      };
    }),

  incidents: orgProcedure
    .input(
      z.object({
        orgId,
        status: z.enum(['open', 'resolved', 'all']).default('open'),
        limit: z.number().int().min(1).max(200).default(100),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await db.incident.findMany({
        where: { orgId: ctx.orgId, ...(input.status === 'all' ? {} : { status: input.status }) },
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

  acknowledge: orgProcedure
    .input(z.object({ orgId, incidentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const { count } = await db.incident.updateMany({
        where: { id: input.incidentId, orgId: ctx.orgId, acknowledgedAt: null },
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
