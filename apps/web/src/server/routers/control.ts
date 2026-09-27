import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { PanelIntent } from '@kestrel/model';
import { portalIntent, portalSnapshot } from '../control-service';
import { effectivePanel, readPanel } from '../panel-settings';
import { orgPanelBranding } from '../provider-brand';
import { controlProcedure, orgProcedure, router } from '../trpc';

const orgId = z.string().uuid();
const roomId = z.string().uuid();

// Control from the portal is open to everyone in the organisation, customers included: it is the
// same as pressing the panel in the room. Polled about once a second while the page is open.
export const controlRouter = router({
  snapshot: orgProcedure.input(z.object({ orgId, roomId })).query(async ({ ctx, input }) => {
    const snap = await portalSnapshot(db, { orgId: ctx.orgId, roomId: input.roomId });
    if (!snap) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found' });
    const [room, org] = await Promise.all([
      db.room.findFirst({ where: { id: input.roomId, orgId: ctx.orgId }, select: { panel: true } }),
      db.org.findFirst({ where: { id: ctx.orgId }, select: { branding: true } }),
    ]);
    const { branding } = effectivePanel(
      readPanel(room?.panel),
      await orgPanelBranding(db, ctx.orgId, org?.branding),
    );
    return { ...snap, branding };
  }),

  intent: controlProcedure
    .input(z.object({ orgId, roomId, intent: PanelIntent }))
    .mutation(async ({ ctx, input }) => {
      const res = await portalIntent(db, {
        orgId: ctx.orgId,
        roomId: input.roomId,
        intent: input.intent,
        by: ctx.user.id,
      });
      if (!res.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: res.error });
      return { ok: true };
    }),
});
