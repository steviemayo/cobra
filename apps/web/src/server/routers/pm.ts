import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { PmItems, PmResult, type PmItem } from '@kestrel/model';
import { writeAudit } from '../audit';
import {
  PM_PHOTO_MAX_BYTES,
  PM_PHOTO_TYPES,
  addPhoto,
  addStarterTemplates,
  correctRun,
  correctionsOf,
  getPhoto,
  listPhotos,
  removePhoto,
  createSchedule,
  createTemplate,
  deleteSchedule,
  deleteTemplate,
  discardRun,
  exportVisits,
  issuePmReport,
  listRuns,
  listSchedules,
  pmStatus,
  roomsInScope,
  saveRun,
  signRun,
  skipSegment,
  startRun,
  unskipSegment,
  updateTemplate,
  PM_SCOPES,
} from '../pm-service';
import { loadSigningKey } from '../signing';
import { SITE_SCOPED, roomIdsInScope, type SiteScope } from '../site-scope';
import { featureProcedure, requireRole, router } from '../trpc';

// Preventative maintenance is a Premium feature (and part of a running trial).
const orgProcedure = featureProcedure('maintenance');

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
  if (run.multi) {
    // A visit to several rooms is open to someone limited to some sites only when every room is theirs.
    const rooms = await scopedRooms(ctx.orgId, ctx.siteScope);
    if (rooms) {
      const kids = await db.pmRun.findMany({ where: { orgId: ctx.orgId, parentRunId: run.id } });
      if (kids.some((k) => !k.roomId || !rooms.has(k.roomId)))
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'That is not at a site you look after.',
        });
    }
  } else await assertRoom(ctx.orgId, ctx.siteScope, run.roomId);
  return run;
}

const scopeInput = {
  scope: z.enum(PM_SCOPES).default('room'),
  siteId: id.nullable().optional(),
  areaId: id.nullable().optional(),
  roomIds: z.array(id).max(200).nullable().optional(),
};

/** A multi-room request must cover only rooms the caller may work in. */
async function assertScope(
  ctx: { orgId: string; siteScope: SiteScope },
  input: {
    scope: (typeof PM_SCOPES)[number];
    siteId?: string | null;
    areaId?: string | null;
    roomIds?: string[] | null;
  },
) {
  if (input.scope === 'room') return;
  const covered = await roomsInScope(db, ctx.orgId, input);
  if (!covered.ok) return fail(covered.message);
  const allowed = await scopedRooms(ctx.orgId, ctx.siteScope);
  if (allowed && covered.value.rooms.some((r) => !allowed.has(r.id)))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'That is not at a site you look after.' });
}

/** Who to show as having done the work. */
const workerName = (user: {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}) => {
  const m = user.user_metadata ?? {};
  const n =
    typeof m.full_name === 'string' ? m.full_name : typeof m.name === 'string' ? m.name : '';
  return (n || user.email || '').slice(0, 100) || null;
};

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
          if (s.scope !== 'room') return s.scopeRoomIds.some((r) => scope.has(r));
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
        ...scopeInput,
        intervalDays: z.number().int().min(1).max(1095),
        firstDueOn: z.coerce.date(),
        leadDays: z.number().int().min(0).max(60).default(7),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      if (input.roomId) await assertRoom(ctx.orgId, ctx.siteScope, input.roomId);
      await assertScope(ctx, input);
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

  /** Visits, newest first, for the organisation, a room or a device. A visit to several rooms is one row with a segment for each. */
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
    .query(async ({ ctx, input }) =>
      listRuns(db, ctx.orgId, input, await scopedRooms(ctx.orgId, ctx.siteScope)),
    ),

  /** The same visits with every answer, for the CSV and PDF downloads. */
  exportRuns: orgProcedure
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId,
        roomId: id.optional(),
        deviceId: id.optional(),
        runId: id.optional(),
        status: z.enum(['draft', 'signed']).optional(),
        failedOnly: z.boolean().default(false),
      }),
    )
    .query(async ({ ctx, input }) => {
      return exportVisits(
        db,
        ctx.orgId,
        { ...input, limit: 500 },
        await scopedRooms(ctx.orgId, ctx.siteScope),
      );
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
      const [photos, corrections, original] = await Promise.all([
        listPhotos(db, ctx.orgId, run.id),
        correctionsOf(db, ctx.orgId, run.id),
        run.correctsRunId
          ? db.pmRun.findFirst({ where: { id: run.correctsRunId, orgId: ctx.orgId } })
          : null,
      ]);
      // A visit to several rooms: each room is a segment with its own answers, notes and photos.
      const kids = run.multi
        ? await db.pmRun.findMany({
            where: { orgId: ctx.orgId, parentRunId: run.id },
            orderBy: { createdAt: 'asc' },
          })
        : [];
      const kidRooms = kids.length
        ? await db.room.findMany({
            where: {
              orgId: ctx.orgId,
              id: { in: kids.flatMap((k) => (k.roomId ? [k.roomId] : [])) },
            },
            select: { id: true, name: true },
          })
        : [];
      const kidDevices = kids.some((k) => k.deviceId)
        ? await db.device.findMany({
            where: {
              orgId: ctx.orgId,
              id: { in: kids.flatMap((k) => (k.deviceId ? [k.deviceId] : [])) },
            },
            select: { id: true, name: true },
          })
        : [];
      const segments = await Promise.all(
        kids.map(async (k) => ({
          id: k.id,
          status: k.status,
          roomId: k.roomId,
          roomName: kidRooms.find((x) => x.id === k.roomId)?.name ?? null,
          deviceId: k.deviceId,
          deviceName: kidDevices.find((x) => x.id === k.deviceId)?.name ?? null,
          failedCount: k.failedCount,
          skipReason: k.skipReason,
          workedByName: k.workedByName,
          notes: k.notes,
          results: PmResult.array().catch([]).parse(k.results),
          photos: await listPhotos(db, ctx.orgId, k.id),
        })),
      );
      const parent = run.parentRunId
        ? await db.pmRun.findFirst({ where: { id: run.parentRunId, orgId: ctx.orgId } })
        : null;
      return {
        ...run,
        results: PmResult.array().catch([]).parse(run.results),
        items: PmItems.catch([]).parse(template?.items) as PmItem[],
        roomName: room?.name ?? null,
        deviceName: device?.name ?? null,
        photos,
        segments,
        /** Set when this is one room of a visit to several: open that visit instead. */
        parentRunId: parent?.id ?? null,
        /** Visits that correct this one. A signed one means this visit has been replaced. */
        corrections: corrections.map((c) => ({
          id: c.id,
          status: c.status,
          signedAt: c.signedAt,
          signedByName: c.signedByName,
          reason: c.correctionReason,
        })),
        /** Set on a correction: the signed visit it replaces. */
        corrects: original
          ? { id: original.id, signedAt: original.signedAt, signedByName: original.signedByName }
          : null,
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
        ...scopeInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      if (input.roomId) await assertRoom(ctx.orgId, ctx.siteScope, input.roomId);
      if (input.scheduleId) {
        const sch = await db.pmSchedule.findFirst({
          where: { id: input.scheduleId, orgId: ctx.orgId },
        });
        if (sch && sch.scope !== 'room')
          await assertScope(ctx, {
            scope: sch.scope as (typeof PM_SCOPES)[number],
            siteId: sch.siteId,
            areaId: sch.areaId,
            roomIds: sch.roomIds,
          });
      } else await assertScope(ctx, input);
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
      const res = await saveRun(db, {
        ...input,
        orgId: ctx.orgId,
        userId: ctx.user.id,
        userName: workerName(ctx.user),
      });
      if (!res.ok) return fail(res.message);
      return res.value;
    }),

  /** One room of a multi-room visit was not done: say why, so the rest can be signed off. */
  skipRoom: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, runId: id, reason: z.string().trim().min(3).max(300) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      await runFor(ctx, input.runId);
      const res = await skipSegment(db, { ...input, orgId: ctx.orgId });
      if (!res.ok) return fail(res.message);
      return res.value;
    }),

  unskipRoom: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, runId: id }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      await runFor(ctx, input.runId);
      const res = await unskipSegment(db, { ...input, orgId: ctx.orgId });
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

  // Photos for a photo item. The browser shrinks them first; the picture travels as base64.
  addPhoto: orgProcedure
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId,
        runId: id,
        itemId: z.string().min(1).max(40),
        mime: z.enum(PM_PHOTO_TYPES),
        data: z.string().max(Math.ceil((PM_PHOTO_MAX_BYTES * 4) / 3) + 8),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      await runFor(ctx, input.runId);
      const res = await addPhoto(db, { ...input, orgId: ctx.orgId, userId: ctx.user.id });
      if (!res.ok) return fail(res.message);
      return res.value;
    }),

  removePhoto: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, runId: id, photoId: id }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      await runFor(ctx, input.runId);
      const res = await removePhoto(db, { ...input, orgId: ctx.orgId });
      if (!res.ok) return fail(res.message);
      return res.value;
    }),

  photo: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, runId: id, photoId: id }))
    .query(async ({ ctx, input }) => {
      await runFor(ctx, input.runId);
      const res = await getPhoto(db, { ...input, orgId: ctx.orgId });
      if (!res.ok) return fail(res.message);
      return res.value;
    }),

  // A signed visit is never edited: this starts a correction (a new draft linked to it).
  correctRun: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, runId: id, reason: z.string().trim().min(5).max(500) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      await runFor(ctx, input.runId);
      const res = await correctRun(db, { ...input, orgId: ctx.orgId, userId: ctx.user.id });
      if (!res.ok) return fail(res.message);
      if (!res.value.existing)
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'pm.run_correct',
          target: input.runId,
          meta: { correction: res.value.id, reason: input.reason },
        });
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
