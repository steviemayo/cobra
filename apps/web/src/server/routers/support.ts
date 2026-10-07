import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { writeAudit } from '../audit';
import {
  CONNECTOR_TYPES,
  createConnector,
  deleteConnector,
  rotateInboundSecret,
  setConnectorEnabled,
  simulateDemoReply,
} from '../itsm-service';
import { MUTE_SCOPES, setMute } from '../alert-mute';
import {
  WINDOW_REPEATS,
  endMaintenanceMode,
  startMaintenanceMode,
  WINDOW_SCOPES,
  createWindow,
  deleteWindow,
  upcomingWindows,
} from '../maintenance';
import { maintenanceClashes } from '../room-calendar';
import { PRIORITY_ORDER, createRule, deleteRule, updateRule } from '../ticket-automation';
import { featureProcedure, orgProcedure, requireRole, router } from '../trpc';

// Ticket rules and service desk connections are a Premium feature (and part of a running trial).
const desk = featureProcedure('serviceDesk');

const orgId = z.string().uuid();
const id = z.string().uuid();
const TEAM = ['owner', 'dev', 'support'] as const;
const ADMIN = ['owner', 'dev'] as const;

function fail(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}

const rule = {
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().optional(),
  kinds: z.array(z.string().max(40)).max(20).optional(),
  minSeverity: z.enum(['info', 'warning', 'critical']).optional(),
  siteIds: z.array(id).max(50).optional(),
  afterMinutes: z.number().int().min(0).max(1440).optional(),
  priority: z.enum(PRIORITY_ORDER).optional(),
  routeTo: z.string().max(60).optional(),
  escalateAfterMinutes: z.number().int().min(0).max(10080).optional(),
  escalatePriority: z.enum(PRIORITY_ORDER).optional(),
  escalateTo: z.string().max(60).optional(),
};

// Maintenance windows, auto-ticket rules and service desk connectors (docs/pivot-monitoring.md).
export const supportRouter = router({
  windows: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    const [windows, sites, rooms, devices] = await Promise.all([
      upcomingWindows(db, ctx.orgId, new Date()),
      db.site.findMany({ where: { orgId: ctx.orgId }, select: { id: true, name: true } }),
      db.room.findMany({ where: { orgId: ctx.orgId }, select: { id: true, name: true } }),
      db.device.findMany({ where: { orgId: ctx.orgId }, select: { id: true, name: true } }),
    ]);
    const name = (scope: string, scopeId: string | null) =>
      scope === 'org'
        ? 'Everything'
        : ((scope === 'site' ? sites : scope === 'room' ? rooms : devices).find(
            (x) => x.id === scopeId,
          )?.name ?? 'Removed');
    const now = Date.now();
    return windows.map((w) => ({
      ...w,
      coversName: name(w.scope, w.scopeId),
      active: w.startsAt.getTime() <= now && w.endsAt.getTime() > now,
    }));
  }),

  // Meetings that would be disturbed by planned maintenance, and times that suit, from the rooms'
  // calendars. Checked before a window is saved; it never blocks saving.
  windowClashes: orgProcedure
    .input(
      z.object({
        orgId,
        scope: z.enum(WINDOW_SCOPES),
        scopeId: id.nullable().optional(),
        startsAt: z.coerce.date(),
        endsAt: z.coerce.date(),
        repeat: z.enum(WINDOW_REPEATS).default('none'),
        repeatUntil: z.coerce.date().nullable().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      if (input.endsAt.getTime() <= input.startsAt.getTime())
        return { clashes: [], rooms: 0, checked: 0, horizonDays: 14, suggestions: [] };
      return maintenanceClashes(db, ctx.orgId, { ...input, scopeId: input.scopeId ?? null });
    }),

  createWindow: orgProcedure
    .input(
      z.object({
        orgId,
        name: z.string().trim().min(1).max(80),
        scope: z.enum(WINDOW_SCOPES),
        scopeId: id.nullable().optional(),
        startsAt: z.coerce.date(),
        endsAt: z.coerce.date(),
        repeat: z.enum(WINDOW_REPEATS).default('none'),
        repeatUntil: z.coerce.date().nullable().optional(),
        reason: z.string().trim().max(300).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      const res = await createWindow(db, { ...input, orgId: ctx.orgId, userId: ctx.user.id });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'maintenance.create',
        target: res.value.id,
        meta: { name: input.name, scope: input.scope },
      });
      return res.value;
    }),

  // Mute alert notifications for a room, a site or the whole organisation. Incidents are still raised.
  setMute: orgProcedure
    .input(
      z.object({
        orgId,
        scope: z.enum(MUTE_SCOPES),
        scopeId: id.nullable().optional(),
        muted: z.boolean(),
        until: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      const res = await setMute(db, { ...input, orgId: ctx.orgId }, new Date());
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: input.muted ? 'alerts.mute' : 'alerts.unmute',
        target: input.scopeId ?? ctx.orgId,
        meta: { scope: input.scope, until: input.until?.toISOString() ?? null },
      });
      return { ok: true };
    }),

  // Maintenance mode: no incidents, alerts or tickets for the scope until the time is up or it is ended.
  startMaintenance: orgProcedure
    .input(
      z.object({
        orgId,
        scope: z.enum(MUTE_SCOPES),
        scopeId: id.nullable().optional(),
        hours: z.number().min(0.25).max(24 * 31),
        reason: z.string().trim().max(300).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      const res = await startMaintenanceMode(
        db,
        { ...input, orgId: ctx.orgId, userId: ctx.user.id },
        new Date(),
      );
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'maintenance.start',
        target: res.value.id,
        meta: { scope: input.scope, hours: input.hours },
      });
      return res.value;
    }),

  endMaintenance: orgProcedure
    .input(z.object({ orgId, scope: z.enum(MUTE_SCOPES), scopeId: id.nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      const ended = await endMaintenanceMode(db, { ...input, orgId: ctx.orgId }, new Date());
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'maintenance.end',
        target: input.scopeId ?? ctx.orgId,
        meta: { scope: input.scope },
      });
      return { ended };
    }),

  deleteWindow: orgProcedure
    .input(z.object({ orgId, windowId: id }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      const res = await deleteWindow(db, ctx.orgId, input.windowId);
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'maintenance.delete',
        target: input.windowId,
      });
      return res.value;
    }),

  rules: desk
    .input(z.object({ orgId }))
    .query(({ ctx }) =>
      db.ticketRule.findMany({ where: { orgId: ctx.orgId }, orderBy: { sortOrder: 'asc' } }),
    ),

  createRule: desk.input(z.object({ orgId, ...rule })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, [...ADMIN]);
    const { orgId: _o, ...rest } = input;
    void _o;
    const res = await createRule(db, ctx.orgId, rest);
    if (!res.ok) return fail(res.message);
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: 'ticket_rule.create',
      target: res.value.id,
      meta: { name: input.name },
    });
    return res.value;
  }),

  updateRule: desk
    .input(z.object({ orgId, ruleId: id }).extend(z.object(rule).partial().shape))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...ADMIN]);
      const { orgId: _o, ruleId, ...rest } = input as Record<string, unknown> & { ruleId: string };
      void _o;
      const res = await updateRule(db, ctx.orgId, ruleId, rest);
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'ticket_rule.update',
        target: ruleId,
      });
      return res.value;
    }),

  deleteRule: desk.input(z.object({ orgId, ruleId: id })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, [...ADMIN]);
    const res = await deleteRule(db, ctx.orgId, input.ruleId);
    if (!res.ok) return fail(res.message);
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: 'ticket_rule.delete',
      target: input.ruleId,
    });
    return res.value;
  }),

  /** Service desk connectors. A secret is never sent back. */
  connectors: desk.input(z.object({ orgId })).query(async ({ ctx }) => {
    requireRole(ctx.role, [...ADMIN]);
    const [rows, links] = await Promise.all([
      db.itsmConnector.findMany({ where: { orgId: ctx.orgId }, orderBy: { createdAt: 'asc' } }),
      db.itsmLink.findMany({ where: { orgId: ctx.orgId } }),
    ]);
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      enabled: c.enabled,
      url: ((c.config ?? {}) as { url?: string }).url ?? null,
      signed: !!c.sealedSecret,
      linkedTickets: links.filter((l) => l.connectorId === c.id).length,
      createdAt: c.createdAt,
    }));
  }),

  createConnector: desk
    .input(
      z.object({
        orgId,
        name: z.string().trim().min(1).max(80),
        type: z.enum(CONNECTOR_TYPES),
        url: z.string().url().max(2000).nullable().optional(),
        secret: z.string().min(8).max(200).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...ADMIN]);
      const res = await createConnector(db, { ...input, orgId: ctx.orgId, userId: ctx.user.id });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'itsm.create',
        target: res.value.id,
        meta: { type: input.type, name: input.name },
      });
      // The one time the inbound secret is shown.
      return res.value;
    }),

  setConnectorEnabled: desk
    .input(z.object({ orgId, connectorId: id, enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...ADMIN]);
      const res = await setConnectorEnabled(db, ctx.orgId, input.connectorId, input.enabled);
      if (!res.ok) return fail(res.message);
      return res.value;
    }),

  rotateSecret: desk
    .input(z.object({ orgId, connectorId: id }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...ADMIN]);
      const res = await rotateInboundSecret(db, ctx.orgId, input.connectorId);
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'itsm.rotate_secret',
        target: input.connectorId,
      });
      return res.value;
    }),

  deleteConnector: desk
    .input(z.object({ orgId, connectorId: id }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...ADMIN]);
      const res = await deleteConnector(db, ctx.orgId, input.connectorId);
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'itsm.delete',
        target: input.connectorId,
      });
      return res.value;
    }),

  /** What has passed between Kestrel and one desk, newest first. */
  log: desk.input(z.object({ orgId, connectorId: id })).query(async ({ ctx, input }) => {
    requireRole(ctx.role, [...ADMIN]);
    const c = await db.itsmConnector.findFirst({
      where: { id: input.connectorId, orgId: ctx.orgId },
    });
    if (!c) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such connector' });
    return db.itsmSyncLog.findMany({
      where: { connectorId: c.id },
      orderBy: { at: 'desc' },
      take: 50,
    });
  }),

  /** Tickets sent to a connector's desk, with the reference on the other side. */
  links: desk.input(z.object({ orgId, connectorId: id })).query(async ({ ctx, input }) => {
    requireRole(ctx.role, [...ADMIN]);
    const [links, tickets] = await Promise.all([
      db.itsmLink.findMany({
        where: { orgId: ctx.orgId, connectorId: input.connectorId },
        orderBy: { lastSyncAt: 'desc' },
        take: 50,
      }),
      db.ticket.findMany({
        where: { orgId: ctx.orgId },
        select: { id: true, title: true, status: true },
      }),
    ]);
    return links.map((l) => ({ ...l, ticket: tickets.find((t) => t.id === l.ticketId) ?? null }));
  }),

  /** For the demo desk: answers as the outside system would, to show the round trip. */
  simulateDemo: desk
    .input(
      z.object({
        orgId,
        connectorId: id,
        ticketId: id,
        action: z.enum(['work', 'resolve', 'comment']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...ADMIN]);
      const res = await simulateDemoReply(db, { ...input, orgId: ctx.orgId });
      if (!res.ok) return fail(res.message);
      return res.value;
    }),
});
