import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db, type Prisma } from '@kestrel/db';
import { alertChannelAllowed } from '@kestrel/model';
import {
  ChannelConfig,
  channelRules,
  deliverToChannel,
  portalLink,
  type AlertMessage,
} from '../alerts';
import { ChannelRules, describeRules, hasRules } from '../alert-rules';
import { writeAudit } from '../audit';
import { getEntitlements, planRequired } from '../billing';
import { assertPublicUrl } from '../outbound';
import { featureProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const monitoringProcedure = featureProcedure('alerts');
const channelId = z.string().uuid();
const name = z.string().trim().min(1).max(80);
const severity = z.enum(['info', 'warning', 'critical']);

/** Channel settings can hold secrets and private URLs, so the browser only gets a description of them. */
function describe(type: string, config: unknown): { summary: string; hasSecret: boolean } {
  const c = (config ?? {}) as Record<string, unknown>;
  const host = (u: unknown) => {
    try {
      return new URL(String(u)).host;
    } catch {
      return 'invalid address';
    }
  };
  switch (type) {
    case 'email':
      return { summary: ((c.to as string[]) ?? []).join(', '), hasSecret: false };
    case 'sms':
      return { summary: ((c.to as string[]) ?? []).join(', '), hasSecret: false };
    case 'teams':
      return { summary: host(c.url), hasSecret: false };
    case 'webhook':
      return { summary: host(c.url), hasSecret: typeof c.secret === 'string' };
    case 'itsm':
      return {
        summary: c.url
          ? `${String(c.system ?? 'generic')} at ${host(c.url)}`
          : `${String(c.system ?? 'generic')} (no address yet)`,
        hasSecret: false,
      };
    default:
      return { summary: '', hasSecret: false };
  }
}

async function checkDestination(config: ChannelConfig) {
  if ('url' in config && config.url) {
    try {
      await assertPublicUrl(config.url);
    } catch (e) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: e instanceof Error ? e.message : 'Invalid address',
      });
    }
  }
}

function split(config: ChannelConfig): { type: string; config: Prisma.InputJsonValue } {
  const { type, ...rest } = config;
  return { type, config: rest as Prisma.InputJsonValue };
}

async function find(ctxOrgId: string, id: string) {
  const ch = await db.alertChannel.findFirst({ where: { id, orgId: ctxOrgId } });
  if (!ch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Channel not found' });
  return ch;
}

export const alertRouter = router({
  channels: monitoringProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    requireRole(ctx.role, ['owner', 'dev', 'support']);
    const rows = await db.alertChannel.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { createdAt: 'asc' },
    });
    const recent = await db.alertDelivery.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { at: 'desc' },
      take: 200,
    });
    const entitlements = await getEntitlements(db, ctx.orgId);
    return rows.map((c) => {
      const last = recent.find((d) => d.channelId === c.id);
      return {
        /** True when the plan no longer lets this kind of channel send (a lapsed Premium organisation). */
        locked: !alertChannelAllowed(entitlements, c.type),
        id: c.id,
        name: c.name,
        type: c.type,
        minSeverity: c.minSeverity,
        enabled: c.enabled,
        ...describe(c.type, c.config),
        rules: channelRules(c),
        rulesText: describeRules(channelRules(c)),
        lastDelivery: last
          ? { status: last.status, error: last.error, at: last.at, event: last.event }
          : null,
      };
    });
  }),

  create: monitoringProcedure
    .input(
      z.object({ orgId, name, minSeverity: severity.default('warning'), config: ChannelConfig }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const { type, config } = split(input.config);
      if (!alertChannelAllowed(await getEntitlements(db, ctx.orgId), type))
        throw new TRPCError({ code: 'FORBIDDEN', message: planRequired('allAlertChannels') });
      await checkDestination(input.config);
      const row = await db.alertChannel.create({
        data: {
          orgId: ctx.orgId,
          name: input.name,
          type,
          config,
          minSeverity: input.minSeverity,
          createdBy: ctx.user.id,
        },
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'alert_channel.create',
        target: row.id,
        meta: { name: input.name, type },
      });
      return { id: row.id };
    }),

  update: monitoringProcedure
    .input(
      z.object({
        orgId,
        channelId,
        name: name.optional(),
        minSeverity: severity.optional(),
        enabled: z.boolean().optional(),
        config: ChannelConfig.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const existing = await find(ctx.orgId, input.channelId);
      const data: Prisma.AlertChannelUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.minSeverity !== undefined) data.minSeverity = input.minSeverity;
      if (input.enabled !== undefined) data.enabled = input.enabled;
      if (input.config) {
        if (input.config.type !== existing.type)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'A channel’s type can’t be changed. Add a new channel instead',
          });
        await checkDestination(input.config);
        // Leaving the secret out keeps the one already saved, since the browser never sees it.
        const prior = (existing.config ?? {}) as Record<string, unknown>;
        const merged =
          input.config.type === 'webhook' &&
          !input.config.secret &&
          typeof prior.secret === 'string'
            ? { ...input.config, secret: prior.secret }
            : input.config;
        data.config = split(merged as ChannelConfig).config;
      }
      await db.alertChannel.update({ where: { id: existing.id }, data });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'alert_channel.update',
        target: existing.id,
        meta: { name: existing.name },
      });
      return { ok: true };
    }),

  // Set (or clear, with null) when a channel may alert and how it escalates. The destination and any
  // secret stay as they are.
  setRules: monitoringProcedure
    .input(z.object({ orgId, channelId, rules: ChannelRules.nullable() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const ch = await find(ctx.orgId, input.channelId);
      const rest = { ...((ch.config ?? {}) as Record<string, unknown>) };
      delete rest.rules;
      const next = input.rules && hasRules(input.rules) ? { ...rest, rules: input.rules } : rest;
      await db.alertChannel.update({
        where: { id: ch.id },
        data: { config: next as Prisma.InputJsonValue },
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'alert_channel.rules',
        target: ch.id,
        meta: { name: ch.name, rules: describeRules(input.rules) ?? 'none' },
      });
      return { ok: true };
    }),

  delete: monitoringProcedure
    .input(z.object({ orgId, channelId }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const ch = await find(ctx.orgId, input.channelId);
      await db.alertChannel.delete({ where: { id: ch.id } });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'alert_channel.delete',
        target: ch.id,
        meta: { name: ch.name },
      });
      return { ok: true };
    }),

  // Sends a made-up alert so people can see it arrive before a real one matters.
  test: monitoringProcedure
    .input(z.object({ orgId, channelId }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const ch = await find(ctx.orgId, input.channelId);
      const msg: AlertMessage = {
        event: 'test',
        incident: {
          id: crypto.randomUUID(),
          kind: 'test',
          severity: 'warning',
          title: 'This is a test alert from Kestrel',
          detail: 'If you can read this, alerts to this channel work.',
          room: null,
          openedAt: new Date().toISOString(),
          resolvedAt: null,
        },
        portalUrl: portalLink(ctx.orgId, '/alerts'),
      };
      return deliverToChannel(db, ch, msg, null);
    }),

  deliveries: monitoringProcedure
    .input(z.object({ orgId, limit: z.number().int().min(1).max(100).default(30) }))
    .query(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const rows = await db.alertDelivery.findMany({
        where: { orgId: ctx.orgId },
        orderBy: { at: 'desc' },
        take: input.limit,
      });
      const channels = await db.alertChannel.findMany({
        where: { orgId: ctx.orgId },
        select: { id: true, name: true },
      });
      const nameOf = new Map(channels.map((c) => [c.id, c.name]));
      return rows.map((d) => ({
        id: d.id,
        channel: nameOf.get(d.channelId) ?? 'Deleted channel',
        event: d.event,
        status: d.status,
        error: d.error,
        at: d.at,
      }));
    }),
});
