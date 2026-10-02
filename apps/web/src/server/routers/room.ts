import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { after } from 'next/server';
import { db } from '@kestrel/db';
import { ControlPoint, RoomModel, RoomType } from '@kestrel/model';
import { writeAudit } from '../audit';
import { getEntitlements, monitoredRoomIds, roomLimitMessage } from '../billing';
import { saveShape, slotToSource, slotsOf } from '../room-shapes';
import {
  checkCopies,
  describeSlots,
  loadContext,
  MAX_COPIES,
  writeCopies,
  type SourceDevice,
} from '../room-copies';
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
    .input(z.object({ orgId, siteId: z.string().uuid(), name, type: RoomType.optional() }))
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
        data: {
          orgId: ctx.orgId,
          siteId: site.id,
          name: input.name,
          type: input.type ?? 'meeting',
        },
        omit,
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'room.create',
        target: room.id,
        meta: { name: room.name, site: site.name },
      });
      after(() =>
        syncQuantity(db, ctx.orgId).catch((e) =>
          console.error('[billing] quantity sync failed', e),
        ),
      );
      return room;
    }),

  /** Adds several rooms to a site at once. Names already used in the site are skipped. */
  createMany: orgProcedure
    .input(
      z.object({
        orgId,
        siteId: z.string().uuid(),
        names: z.array(name).min(1).max(100),
        type: RoomType.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const site = await assertSite(ctx.orgId, input.siteId);
      const entitlements = await getEntitlements(db, ctx.orgId);
      if (entitlements.maxRooms === 0)
        throw new TRPCError({ code: 'FORBIDDEN', message: roomLimitMessage(entitlements) });
      const taken = new Set(
        (await db.room.findMany({ where: { orgId: ctx.orgId, siteId: site.id } })).map((r) =>
          r.name.toLowerCase(),
        ),
      );
      const fresh: string[] = [];
      const skipped: string[] = [];
      for (const n of input.names) {
        const key = n.toLowerCase();
        if (taken.has(key)) skipped.push(n);
        else {
          taken.add(key);
          fresh.push(n);
        }
      }
      if (fresh.length > 0) {
        await db.room.createMany({
          data: fresh.map((n) => ({
            orgId: ctx.orgId,
            siteId: site.id,
            name: n,
            type: input.type ?? 'meeting',
          })),
        });
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'room.create_many',
          target: site.id,
          meta: { site: site.name, count: fresh.length },
        });
        after(() =>
          syncQuantity(db, ctx.orgId).catch((e) =>
            console.error('[billing] quantity sync failed', e),
          ),
        );
      }
      return { created: fresh.length, skipped };
    }),

  /**
   * What a room is made of, as the shape a copy starts from: its devices with the fields each needs
   * filled in per room, and their control points. No address or login is ever included.
   */
  copyShape: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, roomId: roomId.optional(), shapeId: z.string().uuid().optional() }))
    .query(async ({ ctx, input }) => {
      if (input.shapeId) {
        const shape = await db.roomShape.findFirst({
          where: { id: input.shapeId, orgId: ctx.orgId },
        });
        if (!shape) throw new TRPCError({ code: 'NOT_FOUND', message: 'Shape not found' });
        return {
          room: {
            id: null as string | null,
            name: shape.name,
            siteId: null as string | null,
            gatewayId: null as string | null,
            areaId: null as string | null,
            tags: [] as string[],
          },
          shape: { id: shape.id, name: shape.name },
          devices: describeSlots(slotsOf(shape.slots).map(slotToSource)),
        };
      }
      if (!input.roomId)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose a room or a shape' });
      const room = await db.room.findFirst({
        where: { id: input.roomId, orgId: ctx.orgId, ...siteFilter(ctx.siteScope) },
        select: { id: true, name: true, siteId: true, gatewayId: true, areaId: true, tags: true },
      });
      if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found' });
      const devices = await db.device.findMany({
        where: { orgId: ctx.orgId, roomId: room.id },
        orderBy: { createdAt: 'asc' },
      });
      return {
        room: { ...room, id: room.id as string | null, siteId: room.siteId as string | null },
        shape: null as { id: string; name: string } | null,
        devices: describeSlots(devices as unknown as SourceDevice[]),
      };
    }),

  /** The saved shapes of the organisation. */
  shapes: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    const rows = await db.roomShape.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      devices: slotsOf(r.slots).length,
      createdAt: r.createdAt,
    }));
  }),

  /** Keeps a room's devices, drivers, settings and control points (no addresses or logins) as a named shape. */
  saveShape: orgProcedure
    .input(
      z.object({
        orgId,
        roomId,
        name: z.string().trim().min(1).max(100),
        description: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const res = await saveShape(db, {
        orgId: ctx.orgId,
        roomId: input.roomId,
        name: input.name,
        description: input.description,
        actorId: ctx.user.id,
      });
      if (!res.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: res.message });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'room.shape_save',
        target: res.value.id,
        meta: { name: input.name },
      });
      return res.value;
    }),

  deleteShape: orgProcedure
    .input(z.object({ orgId, shapeId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const shape = await db.roomShape.findFirst({
        where: { id: input.shapeId, orgId: ctx.orgId },
      });
      if (!shape) throw new TRPCError({ code: 'NOT_FOUND', message: 'Shape not found' });
      await db.roomShape.delete({ where: { id: shape.id } });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'room.shape_delete',
        target: shape.id,
        meta: { name: shape.name },
      });
      return { ok: true };
    }),

  /**
   * Makes copies of a room. With `dryRun` it only checks and says what is wrong. Everything is
   * written in one transaction, or nothing is.
   */
  copy: orgProcedure
    .input(
      z.object({
        orgId,
        sourceRoomId: roomId.optional(),
        shapeId: z.string().uuid().optional(),
        /** Where the rooms go, when they are made from a shape. */
        siteId: z.string().uuid().optional(),
        dryRun: z.boolean().default(false),
        copies: z
          .array(
            z.object({
              name: z.string().trim().max(100),
              areaId: z.string().uuid().nullable().optional(),
              tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
              gatewayId: z.string().uuid().nullable().optional(),
              devices: z
                .array(
                  z.object({
                    sourceDeviceId: z.string().uuid(),
                    skip: z.boolean().optional(),
                    name: z.string().trim().min(1).max(80).optional(),
                    values: z
                      .record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()]))
                      .optional(),
                    settings: z
                      .record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()]))
                      .optional(),
                    secrets: z
                      .record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()]))
                      .optional(),
                    credentialSetId: z.string().uuid().nullable().optional(),
                    points: z.array(ControlPoint).max(200).optional(),
                    linkTo: z.string().uuid().optional(),
                  }),
                )
                .max(100),
            }),
          )
          .min(1)
          .max(MAX_COPIES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      let source: {
        id: string;
        name: string;
        siteId: string;
        gatewayId: string | null;
        monitorOnly: boolean;
      };
      let sourceDevices: SourceDevice[];
      if (input.shapeId) {
        const shape = await db.roomShape.findFirst({
          where: { id: input.shapeId, orgId: ctx.orgId },
        });
        if (!shape) throw new TRPCError({ code: 'NOT_FOUND', message: 'Shape not found' });
        if (!input.siteId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose a site' });
        const site = await assertSite(ctx.orgId, input.siteId);
        source = {
          id: shape.id,
          name: shape.name,
          siteId: site.id,
          gatewayId: null,
          monitorOnly: false,
        };
        sourceDevices = slotsOf(shape.slots).map(slotToSource);
      } else {
        if (!input.sourceRoomId)
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose a room or a shape' });
        const room = await findRoom(ctx.orgId, input.sourceRoomId);
        source = room;
        sourceDevices = (await db.device.findMany({
          where: { orgId: ctx.orgId, roomId: room.id },
        })) as SourceDevice[];
      }
      const e = await getEntitlements(db, ctx.orgId);
      const monitored = await monitoredRoomIds(db, ctx.orgId);
      const context = await loadContext(db, ctx.orgId, source.siteId, {
        maxRooms: e.maxRooms,
        monitoredRooms: monitored.size,
      });
      const checked = checkCopies(sourceDevices, input.copies, context);
      const ok = checked.batch.length === 0 && checked.rows.every((r) => r.problems.length === 0);
      if (input.dryRun || !ok)
        return {
          ok,
          created: [] as { roomId: string; name: string; devices: number }[],
          ...checked,
        };

      const created = await db.$transaction(
        (tx) =>
          writeCopies(tx as unknown as Parameters<typeof writeCopies>[0], {
            orgId: ctx.orgId,
            actorId: ctx.user.id,
            source: {
              id: source.id,
              siteId: source.siteId,
              gatewayId: source.gatewayId,
              monitorOnly: source.monitorOnly,
            },
            sourceDevices,
            copies: input.copies,
          }),
        { timeout: 60_000, maxWait: 10_000 },
      );
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'room.copy',
        target: source.id,
        meta: { from: source.name, rooms: created.map((r) => r.name) },
      });
      after(() =>
        syncQuantity(db, ctx.orgId).catch((err) =>
          console.error('[billing] quantity sync failed', err),
        ),
      );
      return { ok: true, created, ...checked };
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
