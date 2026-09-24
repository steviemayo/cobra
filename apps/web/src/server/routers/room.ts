import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { after } from 'next/server';
import { db } from '@kestrel/db';
import { generateSecret, hashSecret } from '@kestrel/crypto';
import { RoomType } from '@kestrel/model';
import { writeAudit } from '../audit';
import { canAddRoom, getEntitlements } from '../billing';
import { createDeployment } from '../deployment-service';
import { effectiveStatus } from '../gateway-service';
import { PanelInput, applyPanelInput, publicPanel, readPanel } from '../panel-settings';
import { summariseDraft } from '../room-summary';
import { syncQuantity } from '../stripe';
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

export const roomRouter = router({
  list: orgProcedure
    .input(z.object({ orgId }))
    .query(({ ctx }) =>
      db.room.findMany({ where: { orgId: ctx.orgId }, orderBy: { createdAt: 'asc' }, omit }),
    ),

  get: orgProcedure.input(z.object({ orgId, roomId })).query(async ({ ctx, input }) => {
    const room = await db.room.findFirst({
      where: { id: input.roomId, orgId: ctx.orgId },
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
  overview: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    const rooms = await db.room.findMany({
      where: { orgId: ctx.orgId },
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
      if (!canAddRoom(entitlements, await db.room.count({ where: { orgId: ctx.orgId } })))
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `Your plan includes ${entitlements.maxRooms} rooms. Subscribe to add more.`,
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
    .input(z.object({ orgId, roomId, name: name.optional(), siteId: z.string().uuid().optional() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const room = await findRoom(ctx.orgId, input.roomId);
      const site = input.siteId ? await assertSite(ctx.orgId, input.siteId) : null;
      const updated = await db.room.update({
        where: { id: room.id },
        data: {
          name: input.name ?? room.name,
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
        meta: { name: updated.name, ...(site && { site: site.name }) },
      });
      return updated;
    }),

  delete: orgProcedure.input(z.object({ orgId, roomId })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const room = await findRoom(ctx.orgId, input.roomId);
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
      await db.room.update({
        where: { id: room.id },
        data: {
          gatewayId: input.gatewayId,
          // The new gateway has not reported on this room yet.
          reportedReleaseId: null,
          reportedHash: null,
          reportedStatus: null,
          reportedError: null,
          reportedAt: null,
        },
      });
      // A room that already has a release follows it to its new gateway.
      if (input.gatewayId && room.desiredReleaseId)
        await createDeployment(db, {
          orgId: ctx.orgId,
          roomId: room.id,
          gatewayId: input.gatewayId,
          releaseId: room.desiredReleaseId,
          kind: 'deploy',
          createdBy: ctx.user.id,
          scheduledFor: null,
        });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'room.gateway',
        target: room.id,
        meta: { room: room.name, gateway: gatewayName },
      });
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
