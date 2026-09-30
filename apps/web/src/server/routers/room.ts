import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { after } from 'next/server';
import { db } from '@kestrel/db';
import { generateSecret, hashSecret } from '@kestrel/crypto';
import { RoomModel, RoomType } from '@kestrel/model';
import { writeAudit } from '../audit';
import { canAddRoom, getEntitlements, roomLimitMessage } from '../billing';
import { checkDeployable } from '../deploy-check';
import { sharedGatewayProblem } from '../site-devices';
import { createDeployment } from '../deployment-service';
import { DuplicateRoomError, duplicateRoom } from '../duplicate-room';
import { effectiveStatus } from '../gateway-service';
import { PanelInput, applyPanelInput, publicPanel, readPanel } from '../panel-settings';
import { summariseDraft } from '../room-summary';
import { syncQuantity } from '../stripe';
import { SITE_SCOPED, siteFilter } from '../site-scope';
import { orgProcedure, requireRole, router } from '../trpc';
import { designOnly } from './room-model-helpers';
import { promoteStaging, PromoteError } from '../promote-staging';
import { STAGING, billedRooms } from '../room-kinds';

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

  // A new room at the same site with this room's design and gateway. Addresses are not copied;
  // the shared logins chosen are.
  duplicate: orgProcedure
    .input(z.object({ orgId, roomId, name, staging: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const source = await findRoom(ctx.orgId, input.roomId);
      if (input.staging && source.kind === STAGING)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'A staging room cannot have a staging copy of its own.',
        });
      if (source.kind === 'combined')
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'A combined room is made from its room group and cannot be copied.',
        });
      const draft = await db.roomDraft.findFirst({
        where: { roomId: source.id, orgId: ctx.orgId },
      });
      if (!draft)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This room has no design to copy yet',
        });
      // A staging room is free, so only a live copy counts against the plan.
      const entitlements = input.staging ? null : await getEntitlements(db, ctx.orgId);
      if (
        entitlements &&
        !canAddRoom(
          entitlements,
          await db.room.count({ where: { orgId: ctx.orgId, ...billedRooms } }),
        )
      )
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: roomLimitMessage(entitlements),
        });
      const model = await designOnly(ctx.orgId, RoomModel.parse(draft.model));
      let copy;
      try {
        copy = await db.$transaction((tx) =>
          duplicateRoom(tx as unknown as Parameters<typeof duplicateRoom>[0], {
            orgId: ctx.orgId,
            source: {
              id: source.id,
              siteId: source.siteId,
              type: source.type,
              gatewayId: source.gatewayId,
            },
            name: input.name,
            model,
            userId: ctx.user.id,
            kind: input.staging ? 'staging' : 'standard',
          }),
        );
      } catch (e) {
        if (e instanceof DuplicateRoomError)
          throw new TRPCError({ code: 'CONFLICT', message: e.message });
        throw e;
      }
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: input.staging ? 'room.staging_copy' : 'room.duplicate',
        target: copy.id,
        meta: { name: copy.name, from: source.name },
      });
      if (!input.staging)
        after(() =>
          syncQuantity(db, ctx.orgId).catch((e) =>
            console.error('[billing] quantity sync failed', e),
          ),
        );
      return copy;
    }),

  // Put a staging room's design into a live room's working draft. Publishes and deploys nothing; the
  // live room's draft is kept as a saved version first. Addresses are not copied.
  promoteStaging: orgProcedure
    .input(z.object({ orgId, roomId, targetRoomId: roomId }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const staging = await findRoom(ctx.orgId, input.roomId);
      const draft = await db.roomDraft.findFirst({
        where: { roomId: staging.id, orgId: ctx.orgId },
      });
      if (!draft)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This room has no design to promote yet',
        });
      const model = await designOnly(ctx.orgId, RoomModel.parse(draft.model));
      try {
        const result = await promoteStaging(db, {
          orgId: ctx.orgId,
          stagingId: staging.id,
          targetId: input.targetRoomId,
          model,
          userId: ctx.user.id,
        });
        if (result.changed) {
          const target = await findRoom(ctx.orgId, input.targetRoomId);
          await writeAudit({
            orgId: ctx.orgId,
            actorId: ctx.user.id,
            action: 'room.staging_promote',
            target: target.id,
            meta: { staging: staging.name, room: target.name },
          });
        }
        return result;
      } catch (e) {
        if (e instanceof PromoteError)
          throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
        throw e;
      }
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

  // Webhook triggers: the names the design listens for, and whether a secret has been set.
  hookInfo: orgProcedure.input(z.object({ orgId, roomId })).query(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const room = await db.room.findFirst({
      where: { id: input.roomId, orgId: ctx.orgId },
      select: { hookSecretHash: true },
    });
    if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found' });
    const draft = await db.roomDraft.findFirst({
      where: { roomId: input.roomId, orgId: ctx.orgId },
      select: { model: true },
    });
    const triggers =
      (draft?.model as { triggers?: { type: string; hookName?: string; enabled?: boolean }[] })
        ?.triggers ?? [];
    return {
      hasSecret: !!room.hookSecretHash,
      hooks: triggers.flatMap((t) => (t.type === 'webhook' && t.hookName ? [t.hookName] : [])),
    };
  }),

  // Shown once. Generating a new one stops the old one working straight away.
  rotateHookSecret: orgProcedure
    .input(z.object({ orgId, roomId }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const room = await findRoom(ctx.orgId, input.roomId);
      const secret = generateSecret(24);
      await db.room.update({
        where: { id: room.id },
        data: { hookSecretHash: hashSecret(secret) },
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'room.hook_secret',
        target: room.id,
        meta: { room: room.name },
      });
      return { secret };
    }),

  getPanel: orgProcedure.input(z.object({ orgId, roomId })).query(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    return publicPanel(readPanel((await findRoom(ctx.orgId, input.roomId)).panel));
  }),

  // Panel access and branding. Takes effect from the next release.
  setPanel: orgProcedure
    .input(PanelInput.extend({ orgId, roomId }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const room = await findRoom(ctx.orgId, input.roomId);
      let next;
      try {
        next = applyPanelInput(readPanel(room.panel), input);
      } catch (e) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: e instanceof Error ? e.message : 'Invalid',
        });
      }
      await db.room.update({ where: { id: room.id }, data: { panel: next } });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'room.panel',
        target: room.id,
        meta: { room: room.name, mode: next.access.mode },
      });
      return publicPanel(next);
    }),
});
