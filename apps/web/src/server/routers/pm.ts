import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { PmItems, PmResult, type PmItem } from '@kestrel/model';
import { writeAudit } from '../audit';
import {
  addStarterTemplates,
  createSchedule,
  createTemplate,
  deleteSchedule,
  deleteTemplate,
  discardRun,
  issuePmReport,
  listSchedules,
  pmStatus,
  saveRun,
  signRun,
  startRun,
  updateTemplate,
} from '../pm-service';
import { loadSigningKey } from '../signing';
import { SITE_SCOPED, roomIdsInScope, type SiteScope } from '../site-scope';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const id = z.string().uuid();
const TEAM = ['owner', 'dev', 'support'] as const;

function fail(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}

/** The rooms a site-limited provider may work in, or null for everyone else. */
async function scopedRooms(orgIdValue: string, scope: SiteScope): Promise<Set<string> | null> {
  if (scope === null) return null;
  const rooms = await db.room.findMany({
    where: { orgId: orgIdValue },
    select: { id: true, siteId: true },
  });
  return roomIdsInScope(rooms, scope);
}

async function assertRoom(orgIdValue: string, scope: SiteScope, roomId: string | null) {
  const rooms = await scopedRooms(orgIdValue, scope);
  if (rooms && (!roomId || !rooms.has(roomId)))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'That is not at a site you look after.' });
}

async function runFor(ctx: { orgId: string; siteScope: SiteScope }, runId: string) {
  const run = await db.pmRun.findFirst({ where: { id: runId, orgId: ctx.orgId } });
  if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such visit' });
  await assertRoom(ctx.orgId, ctx.siteScope, run.roomId);
  return run;
}

// Preventative maintenance: checklists, schedules and visits (docs/pivot-monitoring.md).
export const pmRouter = router({
  templates: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId }))
    .query(async ({ ctx }) => {
      const rows = await db.pmTemplate.findMany({
        where: { orgId: ctx.orgId },
        orderBy: { name: 'asc' },
      });
      return rows.map((t) => ({ ...t, items: PmItems.catch([]).parse(t.items) as PmItem[] }));
    }),

  createTemplate: orgProcedure
    .input(
      z.object({
        orgId,
        name: z.string().trim().min(1).max(80),
        appliesTo: z.enum(['room', 'device']),
        category: z.string().max(40).nullable().optional(),
        items: z.unknown(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      const res = await createTemplate(db, { ...input, orgId: ctx.orgId, userId: ctx.user.id });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'pm.template_create',
        target: res.value.id,
        meta: { name: input.name },
      });
      return res.value;
    }),

  updateTemplate: orgProcedure
    .input(
      z.object({
        orgId,
        templateId: id,
        name: z.string().trim().min(1).max(80).optional(),
        category: z.string().max(40).nullable().optional(),
        items: z.unknown().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      const res = await updateTemplate(db, { ...input, orgId: ctx.orgId });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'pm.template_update',
        target: input.templateId,
      });
      return res.value;
    }),

  deleteTemplate: orgProcedure
    .input(z.object({ orgId, templateId: id }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const res = await deleteTemplate(db, ctx.orgId, input.templateId);
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'pm.template_delete',
        target: input.templateId,
      });
      return res.value;
    }),

  addStarters: orgProcedure.input(z.object({ orgId })).mutation(async ({ ctx }) => {
    requireRole(ctx.role, [...TEAM]);
    return { added: await addStarterTemplates(db, ctx.orgId, ctx.user.id) };
  }),

  /** Schedules with their state, for the Schedule page or for one room or device. */
  schedules: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, roomId: id.optional(), deviceId: id.optional() }))
    .query(async ({ ctx, input }) => {
      const [list, rooms, devices, scope] = await Promise.all([
        listSchedules(db, ctx.orgId, new Date(), input),
        db.room.findMany({ where: { orgId: ctx.orgId }, select: { id: true, name: true } }),
        db.device.findMany({
          where: { orgId: ctx.orgId },
          select: { id: true, name: true, roomId: true },
        }),
        scopedRooms(ctx.orgId, ctx.siteScope),
      ]);
      return list
        .filter((s) => {
          if (!scope) return true;
          const room = s.roomId ?? devices.find((d) => d.id === s.deviceId)?.roomId ?? null;
          return room !== null && scope.has(room);
        })
        .map((s) => ({
          ...s,
          roomName: rooms.find((r) => r.id === s.roomId)?.name ?? null,
          deviceName: devices.find((d) => d.id === s.deviceId)?.name ?? null,
        }));
    }),

  createSchedule: orgProcedure
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId,
        templateId: id,
        roomId: id.nullable().optional(),
        deviceId: id.nullable().optional(),
        intervalDays: z.number().int().min(1).max(1095),
        firstDueOn: z.coerce.date(),
        leadDays: z.number().int().min(0).max(60).default(7),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      if (input.roomId) await assertRoom(ctx.orgId, ctx.siteScope, input.roomId);
      const res = await createSchedule(db, { ...input, orgId: ctx.orgId, userId: ctx.user.id });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'pm.schedule_create',
        target: res.value.id,
      });
      return res.value;
    }),

  deleteSchedule: orgProcedure
    .input(z.object({ orgId, scheduleId: id }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      const res = await deleteSchedule(db, ctx.orgId, input.scheduleId);
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'pm.schedule_delete',
        target: input.scheduleId,
      });
      return res.value;
    }),

  /** Visits, newest first, for the organisation, a room or a device. */
  runs: orgProcedure
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId,
        roomId: id.optional(),
        deviceId: id.optional(),
        status: z.enum(['draft', 'signed']).optional(),
        failedOnly: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
      }),
    )
    .query(async ({ ctx, input }) => {
      const [rows, rooms, devices, scope] = await Promise.all([
        db.pmRun.findMany({
          where: {
            orgId: ctx.orgId,
            ...(input.roomId ? { roomId: input.roomId } : {}),
            ...(input.deviceId ? { deviceId: input.deviceId } : {}),
            ...(input.status ? { status: input.status } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: input.limit,
        }),
        db.room.findMany({ where: { orgId: ctx.orgId }, select: { id: true, name: true } }),
        db.device.findMany({ where: { orgId: ctx.orgId }, select: { id: true, name: true } }),
        scopedRooms(ctx.orgId, ctx.siteScope),
      ]);
      return rows
        .filter(
          (r) =>
            (!scope || (r.roomId !== null && scope.has(r.roomId))) &&
            (!input.failedOnly || r.failedCount > 0),
        )
        .map((r) => ({
          id: r.id,
          templateName: r.templateName,
          status: r.status,
          failedCount: r.failedCount,
          roomId: r.roomId,
          roomName: rooms.find((x) => x.id === r.roomId)?.name ?? null,
          deviceId: r.deviceId,
          deviceName: devices.find((x) => x.id === r.deviceId)?.name ?? null,
          signedAt: r.signedAt,
          signedByName: r.signedByName,
          dueOn: r.dueOn,
          createdAt: r.createdAt,
        }));
    }),

  run: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, runId: id }))
    .query(async ({ ctx, input }) => {
      const run = await runFor(ctx, input.runId);
      const template = await db.pmTemplate.findFirst({
        where: { id: run.templateId, orgId: ctx.orgId },
      });
      const [room, device] = await Promise.all([
        run.roomId ? db.room.findFirst({ where: { id: run.roomId } }) : null,
        run.deviceId ? db.device.findFirst({ where: { id: run.deviceId } }) : null,
      ]);
      return {
        ...run,
        results: PmResult.array().catch([]).parse(run.results),
        items: PmItems.catch([]).parse(template?.items) as PmItem[],
        roomName: room?.name ?? null,
        deviceName: device?.name ?? null,
      };
    }),

  startRun: orgProcedure
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId,
        templateId: id,
        scheduleId: id.nullable().optional(),
        roomId: id.nullable().optional(),
        deviceId: id.nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      if (input.roomId) await assertRoom(ctx.orgId, ctx.siteScope, input.roomId);
      const res = await startRun(db, { ...input, orgId: ctx.orgId, userId: ctx.user.id });
      if (!res.ok) return fail(res.message);
      return res.value;
    }),

  saveRun: orgProcedure
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId,
        runId: id,
        results: z.unknown(),
        notes: z.string().max(4000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      await runFor(ctx, input.runId);
      const res = await saveRun(db, { ...input, orgId: ctx.orgId });
      if (!res.ok) return fail(res.message);
      return res.value;
    }),

  signRun: orgProcedure
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId,
        runId: id,
        name: z.string().trim().min(1).max(100),
        raiseTicket: z.boolean().default(true),
        markInRepair: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      await runFor(ctx, input.runId);
      const res = await signRun(db, { ...input, orgId: ctx.orgId, userId: ctx.user.id });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'pm.run_sign',
        target: input.runId,
        meta: { failed: res.value.failed },
      });
      return res.value;
    }),

  discardRun: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, runId: id }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      await runFor(ctx, input.runId);
      const res = await discardRun(db, ctx.orgId, input.runId);
      if (!res.ok) return fail(res.message);
      return res.value;
    }),

  status: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId }))
    .query(async ({ ctx }) =>
      pmStatus(db, ctx.orgId, new Date(), await scopedRooms(ctx.orgId, ctx.siteScope)),
    ),

  /** Signs a report of the visits between two dates. */
  issueReport: orgProcedure
    .input(z.object({ orgId, from: z.coerce.date(), to: z.coerce.date() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      let key;
      try {
        key = loadSigningKey();
      } catch {
        return fail('The server has no signing key configured yet');
      }
      const res = await issuePmReport(db, { ...input, orgId: ctx.orgId, userId: ctx.user.id }, key);
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'pm.report_issue',
        target: res.value.id,
        meta: { number: res.value.number },
      });
      return res.value;
    }),
});
