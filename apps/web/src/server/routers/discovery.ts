import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { requestGatewayCommand } from '../commands';
import { discoveryResult } from '../discovery-service';
import { SITE_SCOPED, siteFilter } from '../site-scope';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();

// Finding devices on a gateway's own network, so an installer does not have to hunt for addresses.
// The gateway does the looking; the portal asks, then reads the answer.
export const discoveryRouter = router({
  start: orgProcedure
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId,
        gatewayId: z.string().uuid(),
        subnet: z.string().trim().max(40).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const visible = await db.gateway.findFirst({
        where: { id: input.gatewayId, orgId: ctx.orgId, ...siteFilter(ctx.siteScope) },
        select: { id: true },
      });
      if (!visible) throw new TRPCError({ code: 'NOT_FOUND', message: 'Gateway not found' });
      const res = await requestGatewayCommand(db, {
        orgId: ctx.orgId,
        gatewayId: visible.id,
        type: 'discover_devices',
        args: input.subnet ? { subnet: input.subnet } : undefined,
        requestedBy: ctx.user.id,
      });
      if (!res.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: res.error });
      return { commandId: res.id };
    }),

  result: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, commandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const view = await discoveryResult(db, {
        orgId: ctx.orgId,
        commandId: input.commandId,
        siteScope: ctx.siteScope,
      });
      if (!view) throw new TRPCError({ code: 'NOT_FOUND', message: 'Scan not found' });
      return view;
    }),
});
