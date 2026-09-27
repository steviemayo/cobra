import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { RoomModel } from '@kestrel/model';
import { writeAudit } from '../audit';
import {
  CommissioningError,
  getRun,
  listRuns,
  progress,
  setResult,
  signOff,
  startRun,
} from '../commissioning';
import { SITE_SCOPED, siteFilter } from '../site-scope';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const roomId = z.string().uuid();
const runId = z.string().uuid();
const WORKERS = ['owner', 'dev', 'support'] as const;

/** The room, if the caller may see it (a provider limited to some sites sees only those). */
async function roomFor(ctx: { orgId: string; siteScope: string[] | null }, id: string) {
  const room = await db.room.findFirst({ where: { id, orgId: ctx.orgId, ...siteFilter(ctx.siteScope) } });
  if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found' });
  return room;
}

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((e) => {
    if (e instanceof CommissioningError) throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
    throw e;
  });
}

// Walking through a room to check it works, and signing it off. Anyone who works on rooms can do it,
// including a service provider at the sites it manages.
export const commissioningRouter = router({
  list: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, roomId }))
    .query(async ({ ctx, input }) => {
      await roomFor(ctx, input.roomId);
      return (await listRuns(db, ctx.orgId, input.roomId)).map((r) => ({ ...r, progress: progress(r.items) }));
    }),

  get: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, roomId, runId }))
    .query(async ({ ctx, input }) => {
      const room = await roomFor(ctx, input.roomId);
      const run = await getRun(db, ctx.orgId, input.runId);
      if (!run || run.roomId !== room.id) throw new TRPCError({ code: 'NOT_FOUND', message: 'Check not found' });
      return { ...run, roomName: room.name, progress: progress(run.items) };
    }),

  start: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, roomId }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...WORKERS]);
      const room = await roomFor(ctx, input.roomId);
      const draft = await db.roomDraft.findFirst({ where: { roomId: room.id, orgId: ctx.orgId } });
      if (!draft) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Design the room first. The check is made from its design.' });
      const release = room.desiredReleaseId
        ? await db.release.findFirst({ where: { id: room.desiredReleaseId, orgId: ctx.orgId }, select: { number: true } })
        : null;
      const run = await wrap(() =>
        startRun(db, {
          orgId: ctx.orgId,
          roomId: room.id,
          model: RoomModel.parse(draft.model),
          releaseNumber: release?.number ?? null,
          user: { id: ctx.user.id, email: ctx.user.email ?? null },
        }),
      );
      await writeAudit({ orgId: ctx.orgId, actorId: ctx.user.id, action: 'commissioning.start', target: run.id, meta: { room: room.name } });
      return { id: run.id };
    }),

  setResult: orgProcedure
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId,
        roomId,
        runId,
        itemId: z.string().min(1).max(200),
        result: z.enum(['pending', 'pass', 'fail', 'skip']),
        note: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...WORKERS]);
      const room = await roomFor(ctx, input.roomId);
      const run = await getRun(db, ctx.orgId, input.runId);
      if (!run || run.roomId !== room.id) throw new TRPCError({ code: 'NOT_FOUND', message: 'Check not found' });
      const updated = await wrap(() => setResult(db, { orgId: ctx.orgId, runId: input.runId, itemId: input.itemId, result: input.result, note: input.note }));
      return { progress: progress(updated.items), items: updated.items };
    }),

  signOff: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, roomId, runId, notes: z.string().max(2000).optional() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...WORKERS]);
      const room = await roomFor(ctx, input.roomId);
      const run = await getRun(db, ctx.orgId, input.runId);
      if (!run || run.roomId !== room.id) throw new TRPCError({ code: 'NOT_FOUND', message: 'Check not found' });
      const done = await wrap(() =>
        signOff(db, { orgId: ctx.orgId, runId: input.runId, notes: input.notes, user: { id: ctx.user.id, email: ctx.user.email ?? null } }),
      );
      const p = progress(done.items);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'commissioning.signoff',
        target: done.id,
        meta: { room: room.name, pass: p.pass, fail: p.fail, skip: p.skip },
      });
      return { ok: true };
    }),
});
