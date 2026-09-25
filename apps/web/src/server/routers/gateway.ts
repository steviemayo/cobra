import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { writeAudit } from '../audit';
import { effectiveStatus, newEnrollToken } from '../gateway-service';
import { latestVersions, updateStatus } from '../gateway-updates';
import { SITE_SCOPED, siteFilter } from '../site-scope';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const gatewayId = z.string().uuid();
const name = z.string().trim().min(1).max(100);

// Explicit selection: credentialHash and enrollTokenHash must never be sent to a browser.
const safe = {
  id: true,
  name: true,
  siteId: true,
  version: true,
  channel: true,
  hostname: true,
  os: true,
  enrolledAt: true,
  lastSeenAt: true,
  createdAt: true,
  site: { select: { id: true, name: true } },
  rooms: { select: { id: true, name: true }, orderBy: { name: 'asc' } },
} as const;

async function findGateway(ctxOrgId: string, id: string) {
  const gw = await db.gateway.findFirst({ where: { id, orgId: ctxOrgId } });
  if (!gw) throw new TRPCError({ code: 'NOT_FOUND', message: 'Gateway not found' });
  return gw;
}

export const gatewayRouter = router({
  list: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId }))
    .query(async ({ ctx }) => {
      const gateways = await db.gateway.findMany({
        where: { orgId: ctx.orgId, ...siteFilter(ctx.siteScope) },
        orderBy: { createdAt: 'asc' },
        select: safe,
      });
      const latest = latestVersions();
      return gateways.map((g) => ({
        ...g,
        status: effectiveStatus(g),
        update: updateStatus(g, latest),
      }));
    }),

  // The enrolment token is returned once, here. Only its hash is stored.
  create: orgProcedure
    .input(z.object({ orgId, siteId: z.string().uuid(), name }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const site = await db.site.findFirst({ where: { id: input.siteId, orgId: ctx.orgId } });
      if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'Site not found' });
      const t = newEnrollToken();
      const gw = await db.gateway.create({
        data: {
          orgId: ctx.orgId,
          siteId: site.id,
          name: input.name,
          enrollTokenHash: t.hash,
          enrollTokenExpiresAt: t.expiresAt,
        },
        select: { id: true, name: true },
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'gateway.create',
        target: gw.id,
        meta: { name: gw.name, site: site.name },
      });
      return { id: gw.id, name: gw.name, token: t.token, expiresAt: t.expiresAt };
    }),

  // For a replaced machine: forgets the old credential and issues a fresh one-time token.
  regenerateToken: orgProcedure
    .input(z.object({ orgId, gatewayId }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const gw = await findGateway(ctx.orgId, input.gatewayId);
      const t = newEnrollToken();
      await db.gateway.update({
        where: { id: gw.id },
        data: {
          enrollTokenHash: t.hash,
          enrollTokenExpiresAt: t.expiresAt,
          credentialHash: null,
          enrolledAt: null,
          status: 'pending',
        },
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'gateway.reenroll',
        target: gw.id,
        meta: { name: gw.name },
      });
      return { token: t.token, expiresAt: t.expiresAt };
    }),

  rename: orgProcedure
    .input(z.object({ orgId, gatewayId, name }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const gw = await findGateway(ctx.orgId, input.gatewayId);
      await db.gateway.update({ where: { id: gw.id }, data: { name: input.name } });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'gateway.rename',
        target: gw.id,
        meta: { from: gw.name, to: input.name },
      });
      return { ok: true };
    }),

  // Which release channel the gateway's container follows. The machine's own update tool (Watchtower,
  // the Windows service) follows the tag it was installed with; this records the choice for the portal.
  setChannel: orgProcedure
    .input(z.object({ orgId, gatewayId, channel: z.enum(['stable', 'beta']) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const gw = await findGateway(ctx.orgId, input.gatewayId);
      await db.gateway.update({ where: { id: gw.id }, data: { channel: input.channel } });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'gateway.channel',
        target: gw.id,
        meta: { name: gw.name, from: gw.channel, to: input.channel },
      });
      return { ok: true };
    }),

  delete: orgProcedure.input(z.object({ orgId, gatewayId })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const gw = await findGateway(ctx.orgId, input.gatewayId);
    await db.gateway.delete({ where: { id: gw.id } });
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: 'gateway.delete',
      target: gw.id,
      meta: { name: gw.name },
    });
    return { ok: true };
  }),
});
