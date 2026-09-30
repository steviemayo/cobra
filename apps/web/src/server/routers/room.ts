import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { after } from 'next/server';
import { db } from '@kestrel/db';
import { RoomModel, RoomType } from '@kestrel/model';
import { writeAudit } from '../audit';
import { getEntitlements, roomLimitMessage } from '../billing';
import { checkDeployable } from '../deploy-check';
import { sharedGatewayProblem } from '../site-devices';
import { createDeployment } from '../deployment-service';
import { effectiveStatus } from '../gateway-service';
import { summariseDraft } from '../room-summary';
import { syncQuantity } from '../stripe';
import { SITE_SCOPED, siteFilter } from '../site-scope';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const roomId = z.string().uuid();
const name = z.string().trim().min(1).max(100);

// Room.panel holds the panel PIN hash. It is server-only: never send it to a browser.
const omit = { panel: true, hookSecretHash: true } as const;

async function assertSite(ctxOrgId: string, siteId: string) {
  const site = await db.site.findFirst({ where: { id: siteId, orgId: ctxOrgId } });
  if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'Site not found' });
  return site;
}

async function findRoom(ctxOrgId: string, id: string) {
  const room = await db.room.findFirst({ where: { id, orgId: ctxOrgId } });
  if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found' });
  return room;
}

async function applyGateway(
  orgId: string,
  userId: string,
  room: { id: string; name: string; desiredReleaseId: string | null },
  gatewayId: string | null,
  gatewayName: string | null,
) {
  await db.room.update({
    where: { id: room.id },
    data: {
      gatewayId,
      // The new gateway has not reported on this room yet.
      reportedReleaseId: null,
      reportedHash: null,
      reportedStatus: null,
      reportedError: null,
      reportedAt: null,
    },
  });
  // A room that already has a release follows it to its new gateway, unless it is not ready to run
  // there (an address still to fill in, or a gateway that needs updating).
  const ready =
    gatewayId && room.desiredReleaseId
      ? await checkDeployable(db, {
          orgId,
          roomId: room.id,
          gatewayId,
          releaseId: room.desiredReleaseId,
        })
      : null;
  if (gatewayId && room.desiredReleaseId && ready?.ok)
    await createDeployment(db, {
      orgId,
      roomId: room.id,
      gatewayId,
      releaseId: room.desiredReleaseId,
      kind: 'deploy',
      createdBy: userId,
      scheduledFor: null,
    });
  await writeAudit({
    orgId,
    actorId: userId,
    action: 'room.gateway',
    target: room.id,
    meta: {
      room: room.name,
      gateway: gatewayName,
      ...(ready && !ready.ok ? { notDeployed: ready.message } : {}),
    },
  });
}

export const roomRouter = router({
  list: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId }))
    .query(({ ctx }) =>
      db.room.findMany({
        where: { orgId: ctx.orgId, ...siteFilter(ctx.siteScope) },
        orderBy: { createdAt: 'asc' },
        omit,
      }),
    ),

  get: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, roomId }))
    .query(async ({ ctx, input }) => {
      const room = await db.room.findFirst({
        where: { id: input.roomId, orgId: ctx.orgId, ...siteFilter(ctx.siteScope) },
        omit,
        include: {
          site: { select: { id: true, name: true } },
          gateway: { select: { id: true, name: true, lastSeenAt: true, enrolledAt: true } },
        },
      });
      if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found' });
      const { gateway, ...rest } = room;
      return {
        ...rest,
        gateway: gateway
          ? { id: gateway.id, name: gateway.name, status: effectiveStatus(gateway) }
          : null,
      };
    }),

  // Rooms with their site, gateway and a summary of the design draft, for lists and dashboards.
  overview: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId }))
    .query(async ({ ctx }) => {
      const rooms = await db.room.findMany({
        where: { orgId: ctx.orgId, ...siteFilter(ctx.siteScope) },
        orderBy: [{ createdAt: 'asc' }],
        omit,
        include: {
          site: { select: { id: true, name: true } },
          gateway: {
            select: { id: true, name: true, status: true, lastSeenAt: true, enrolledAt: true },
          },
          draft: { select: { revision: true, updatedAt: true, model: true } },
        },
      });
      return rooms.map(({ draft, gateway, ...room }) => ({
        ...room,
        draft: draft ? summariseDraft(draft) : null,
        gateway: gateway
          ? { id: gateway.id, name: gateway.name, status: effectiveStatus(gateway) }
          : null,
      }));
    }),

  create: orgProcedure
    .input(z.object({ orgId, siteId: z.string().uuid(), name, type: RoomType }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const site = await assertSite(ctx.orgId, input.siteId);
      const entitlements = await getEntitlements(db, ctx.orgId);
      // A room is free until it has a monitored device (see monitoredRoomIds), so only an ended
      // trial stops one being added.
      if (entitlements.maxRooms === 0)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: roomLimitMessage(entitlements),
        });
      const room = await db.room.create({
        data: { orgId: ctx.orgId, siteId: site.id, name: input.name, type: input.type },
        omit,
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'room.create',
        target: room.id,
        meta: { name: room.name, site: site.name, type: room.type },
      });
      after(() =>
        syncQuantity(db, ctx.orgId).catch((e) =>
          console.error('[billing] quantity sync failed', e),
        ),
      );
      return room;
    }),

  update: orgProcedure
    .input(
      z.object({
        orgId,
        roomId,
        name: name.optional(),
        siteId: z.string().uuid().optional(),
        monitorOnly: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const room = await findRoom(ctx.orgId, input.roomId);
      const site = input.siteId ? await assertSite(ctx.orgId, input.siteId) : null;
      if (site && site.id !== room.siteId && room.groupId)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This room is in a room group. Take it out of the group before moving it.',
        });
      const updated = await db.room.update({
        where: { id: room.id },
        data: {
          name: input.name ?? room.name,
          monitorOnly: input.monitorOnly ?? room.monitorOnly,
          // A room that moves site can no longer be served by a gateway at the old one.
          ...(site && { siteId: site.id, ...(site.id !== room.siteId && { gatewayId: null }) }),
        },
        omit,
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'room.update',
        target: room.id,
        meta: {
          name: updated.name,
          ...(site && { site: site.name }),
          ...(input.monitorOnly !== undefined && { monitorOnly: input.monitorOnly }),
        },
      });
      return updated;
    }),

  delete: orgProcedure.input(z.object({ orgId, roomId })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const room = await findRoom(ctx.orgId, input.roomId);
    if (room.groupId && room.kind !== 'combined')
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'This room is in a room group. Take it out of the group first.',
      });
    await db.room.delete({ where: { id: room.id } });
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: 'room.delete',
      target: room.id,
      meta: { name: room.name },
    });
    after(() =>
      syncQuantity(db, ctx.orgId).catch((e) => console.error('[billing] quantity sync failed', e)),
    );
    return { ok: true };
  }),

  // Which gateway runs this room. Must be at the same site; null unassigns.
  assignGateway: orgProcedure
    .input(z.object({ orgId, roomId, gatewayId: z.string().uuid().nullable() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const room = await findRoom(ctx.orgId, input.roomId);
      let gatewayName: string | null = null;
      if (input.gatewayId) {
        const gw = await db.gateway.findFirst({ where: { id: input.gatewayId, orgId: ctx.orgId } });
        if (!gw) throw new TRPCError({ code: 'NOT_FOUND', message: 'Gateway not found' });
        if (gw.siteId !== room.siteId)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'A room can only use a gateway at its own site',
          });
        gatewayName = gw.name;
      }
      // A shared device has one connection, so rooms that share one must run on one gateway.
      if (input.gatewayId) {
        const draft = await db.roomDraft.findFirst({
          where: { roomId: room.id, orgId: ctx.orgId },
        });
        const model = draft ? RoomModel.safeParse(draft.model) : null;
        if (model?.success) {
          const shared = await sharedGatewayProblem(db, {
            orgId: ctx.orgId,
            siteId: room.siteId,
            roomId: room.id,
            gatewayId: input.gatewayId,
            model: model.data,
          });
          if (shared) throw new TRPCError({ code: 'BAD_REQUEST', message: shared });
        }
      }
      // Rooms in a group are controlled together, so they always run on one gateway: move them all.
      const targets = room.groupId
        ? await db.room.findMany({ where: { orgId: ctx.orgId, groupId: room.groupId } })
        : [room];
      for (const target of targets)
        await applyGateway(ctx.orgId, ctx.user.id, target, input.gatewayId, gatewayName);
      return { ok: true };
    }),
});
