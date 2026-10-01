import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { after } from 'next/server';
import { db } from '@kestrel/db';
import { DEVICE_FEEDBACK_FIELDS, DeviceDetails, DeviceFeedback } from '@kestrel/model';
import { deliverAlerts } from '../alerts';
import { writeAudit } from '../audit';
import { deviceFeedbackDailyHistory, deviceFeedbackHistory } from '../device-feedback-history';
import { firmwareReport } from '../firmware-report';
import { maybeSweep } from '../monitoring';
import { estateOverview } from '../estate-overview';
import { orgDevices, orgOverview, sharedInRoom } from '../monitoring-queries';
import { affectedForRooms } from '../room-schedule';
import { SITE_SCOPED, siteFilter, type SiteScope } from '../site-scope';
import { featureProcedure, requireRole, router } from '../trpc';
import { validTimeZone } from '../usage-analytics';

const orgId = z.string().uuid();
const monitoringProcedure = featureProcedure('monitoring');
// A history is a report, like Usage: the same plan gate as usage.report and reports.list.
const analyticsProcedure = featureProcedure('analytics');
// "online" is the reachability history every device already has, alongside its feedback fields.
const historyField = z.enum([...DEVICE_FEEDBACK_FIELDS, 'online']);
const historyDays = z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30);

/** The room a history query is about, scoped the same way `room` and `deviceHistory` already are. */
async function assertScopedRoom(orgId: string, roomId: string, scope: SiteScope) {
  const room = await db.room.findFirst({ where: { id: roomId, orgId, ...siteFilter(scope) } });
  if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found' });
  return room;
}

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

  // The v2 Overview: the whole estate (sites, areas, rooms, devices, gateways) in one query.
  estate: monitoringProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId }))
    .query(async ({ ctx }) => {
      const jobs = await maybeSweep(db);
      if (jobs.length) after(() => deliverAlerts(db, jobs));
      return estateOverview(db, ctx.orgId, new Date(), ctx.siteScope);
    }),

  // Every device across the org, flattened, for the org-wide "Devices" list. Polled the same as
  // overview.
  devices: monitoringProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId }))
    .query(({ ctx }) => orgDevices(db, ctx.orgId, ctx.siteScope)),

  room: monitoringProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, roomId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const room = await db.room.findFirst({
        where: { id: input.roomId, orgId: ctx.orgId, ...siteFilter(ctx.siteScope) },
      });
      if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found' });
      const [devices, incidents, events, shared] = await Promise.all([
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
        sharedInRoom(db, ctx.orgId, room, ctx.siteScope),
      ]);
      return {
        shared,
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
          // Same care as feedback: only what the page understands, whatever an older row holds.
          details: DeviceDetails.safeParse(d.details ?? []).data ?? null,
        })),
        incidents,
        events: events.map((e) => ({ ...e, data: (e.data ?? {}) as Record<string, unknown> })),
      };
    }),

  // How long one device's feedback field held each value, over the last `days` (default 30, capped
  // at the 90-day telemetry reach). Works for any device that reports the field, control or not.
  deviceHistory: analyticsProcedure
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId,
        roomId: z.string().uuid(),
        deviceId: z.string().min(1),
        field: historyField,
        days: historyDays,
      }),
    )
    .query(async ({ ctx, input }) => {
      const room = await assertScopedRoom(ctx.orgId, input.roomId, ctx.siteScope);
      const to = new Date();
      const from = new Date(to.getTime() - input.days * 86_400_000);
      return deviceFeedbackHistory(db, {
        orgId: ctx.orgId,
        roomId: room.id,
        deviceId: input.deviceId,
        field: input.field,
        from,
        to,
      });
    }),

  // The same history, split into the viewer's local calendar days, for the history chart.
  deviceHistoryDaily: analyticsProcedure
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId,
        roomId: z.string().uuid(),
        deviceId: z.string().min(1),
        field: historyField,
        days: historyDays,
        /** The viewer's time zone, so the bars line up with their own days. */
        tz: z.string().max(64).default('UTC'),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (!validTimeZone(input.tz))
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown time zone' });
      const room = await assertScopedRoom(ctx.orgId, input.roomId, ctx.siteScope);
      const to = new Date();
      const from = new Date(to.getTime() - input.days * 86_400_000);
      return deviceFeedbackDailyHistory(db, {
        orgId: ctx.orgId,
        roomId: room.id,
        deviceId: input.deviceId,
        field: input.field,
        from,
        to,
        tz: input.tz,
      });
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
      // Meetings the open incidents may disturb, from the rooms' calendars.
      const impact = await affectedForRooms(
        db,
        ctx.orgId,
        [
          ...new Set(
            rows.filter((r) => r.status === 'open').flatMap((r) => (r.roomId ? [r.roomId] : [])),
          ),
        ],
        new Date(),
      );
      return rows.map((r) => ({
        impact: r.status === 'open' && r.roomId ? (impact.get(r.roomId) ?? null) : null,
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

  // For a room's card: the meetings its open incidents may disturb, or null when it has none open.
  roomImpact: monitoringProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, roomId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const room = await assertScopedRoom(ctx.orgId, input.roomId, ctx.siteScope);
      const open = await db.incident.count({
        where: { orgId: ctx.orgId, roomId: room.id, status: 'open' },
      });
      if (open === 0) return null;
      return (await affectedForRooms(db, ctx.orgId, [room.id], new Date())).get(room.id) ?? null;
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
