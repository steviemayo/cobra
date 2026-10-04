import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { UsageKind } from '@kestrel/model';
import { writeAudit } from '../audit';
import { featureProcedure, orgProcedure, requireRole, router } from '../trpc';
import {
  deviceHistoryView,
  estateUsage,
  getDefinition,
  loadWorkingHours,
  resetDefinition,
  roomUsage,
  saveDefinition,
  saveWorkingHours,
  usageInsights,
} from '../usage-service';

const orgId = z.string().uuid();
const id = z.string().uuid();
const analytics = featureProcedure('analytics');
// Editing what counts as in use is a Premium feature; every plan gets the usual rule.
const definitions = featureProcedure('usageDefinitions');
const days = z.number().int().min(1).max(90).default(30);

function fail(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}

// Usage of rooms and history of devices (docs/pivot-monitoring.md, "Analytics").
export const roomUsageRouter = router({
  /** One room's sessions, utilisation and busy hours by its rule. */
  room: analytics
    .input(z.object({ orgId, roomId: id, kind: UsageKind.default('av'), days }))
    .query(async ({ ctx, input }) => {
      const u = await roomUsage(db, { ...input, orgId: ctx.orgId });
      if (!u) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such room' });
      return u;
    }),

  /** Every monitored room ranked, and what stands out. */
  estate: analytics
    .input(z.object({ orgId, kind: UsageKind.default('av'), days }))
    .query(async ({ ctx, input }) => {
      const rows = await estateUsage(db, { ...input, orgId: ctx.orgId });
      const rooms = await db.room.findMany({ where: { orgId: ctx.orgId } });
      const name = (roomId: string) => rooms.find((r) => r.id === roomId)?.name ?? 'A room';
      return {
        rows: rows.map((r) => ({ ...r, roomName: name(r.roomId) })),
        insights: usageInsights(rows, name, input.days),
        working: await loadWorkingHours(db, ctx.orgId),
      };
    }),

  /** A device's charts: only the readings it has reported. */
  device: analytics
    .input(z.object({ orgId, deviceId: id, days }))
    .query(async ({ ctx, input }) => deviceHistoryView(db, { ...input, orgId: ctx.orgId })),

  /** The rule in force for a room (its own, the organisation's, or the usual one), for the editor. */
  definition: orgProcedure
    .input(z.object({ orgId, roomId: id.nullable(), kind: UsageKind }))
    .query(async ({ ctx, input }) => {
      // The organisation's default is read as a room with no rule of its own.
      const own = await db.usageDefinition.findFirst({
        where: { orgId: ctx.orgId, roomId: input.roomId, kind: input.kind },
      });
      const effective = await getDefinition(db, ctx.orgId, input.roomId ?? '', input.kind);
      return { ...effective, hasOwn: !!own };
    }),

  saveDefinition: definitions
    .input(
      z.object({
        orgId,
        roomId: id.nullable(),
        kind: UsageKind,
        rule: z.unknown(),
        holdOffSeconds: z.number().int().min(0).max(3600),
        minOnSeconds: z.number().int().min(0).max(3600),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const res = await saveDefinition(db, { ...input, orgId: ctx.orgId, userId: ctx.user.id });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'usage.definition_save',
        target: input.roomId ?? 'organisation',
        meta: { kind: input.kind },
      });
      return { ok: true };
    }),

  resetDefinition: definitions
    .input(z.object({ orgId, roomId: id.nullable(), kind: UsageKind }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      await resetDefinition(db, ctx.orgId, input.roomId, input.kind);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'usage.definition_reset',
        target: input.roomId ?? 'organisation',
        meta: { kind: input.kind },
      });
      return { ok: true };
    }),

  workingHours: orgProcedure
    .input(z.object({ orgId }))
    .query(({ ctx }) => loadWorkingHours(db, ctx.orgId)),

  saveWorkingHours: orgProcedure
    .input(
      z.object({
        orgId,
        days: z.array(z.number().int().min(0).max(6)).max(7),
        start: z.string().max(5),
        end: z.string().max(5),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const res = await saveWorkingHours(db, ctx.orgId, input);
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'usage.working_hours_save',
      });
      return { ok: true };
    }),
});
