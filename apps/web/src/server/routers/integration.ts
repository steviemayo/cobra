import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { generateSecret, hashSecret, seal } from '@kestrel/crypto';
import { writeAudit } from '../audit';
import { queueAlerts } from '../alert-batch';
import { getProvider, listProviders } from '../integrations/registry';
import { inScope, syncIntegration, unsealCredentials } from '../integrations/sync';
import { realProviderDeps } from '../integrations/types';
import { featureProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const uuid = z.string().uuid();
const name = z.string().trim().min(1).max(80);

// Integrations read device state from a vendor's cloud, so they come with monitoring.
const proc = featureProcedure('monitoring');

const needKey = () => {
  const key = process.env.KESTREL_SECRETS_KEY;
  if (!key)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Integrations are not set up on this Kestrel server yet',
    });
  return key;
};

const provider = (id: string) => {
  const p = getProvider(id);
  if (!p)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'That integration type is not available' });
  return p;
};

async function ownSites(org: string, siteIds: string[]) {
  if (siteIds.length === 0) return;
  const n = await db.site.count({ where: { orgId: org, id: { in: siteIds } } });
  if (n !== new Set(siteIds).size)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'One of those sites is not in this organisation',
    });
}

// Vendor logins are secrets: sealed on the way in, never sent back out. An integration belongs to the
// organisation, is limited to some sites, and either pulls the vendor's rooms in or only updates the
// devices someone has paired to a vendor record.
export const integrationRouter = router({
  providers: proc
    .input(z.object({ orgId }))
    .query(() => listProviders().map((p) => ({ id: p.id, label: p.label }))),

  list: proc.input(z.object({ orgId })).query(async ({ ctx }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const [rows, devices] = await Promise.all([
      db.integration.findMany({
        where: { orgId: ctx.orgId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          provider: true,
          name: true,
          enabled: true,
          siteIds: true,
          defaultSiteId: true,
          autoCreate: true,
          lastSyncAt: true,
          lastOkAt: true,
          lastError: true,
        },
      }),
      db.device.findMany({
        where: { orgId: ctx.orgId, integrationId: { not: null } },
        select: { integrationId: true },
      }),
    ]);
    return {
      available: !!process.env.KESTREL_SECRETS_KEY,
      integrations: rows.map((r) => ({
        ...r,
        label: getProvider(r.provider)?.label ?? r.provider,
        push: getProvider(r.provider)?.mode === 'push',
        devices: devices.filter((d) => d.integrationId === r.id).length,
      })),
    };
  }),

  // Signs in once to prove the credentials work before anything is saved.
  connect: proc
    .input(
      z.object({
        orgId,
        provider: z.string().max(40),
        name,
        credentials: z.record(z.string(), z.unknown()),
        siteIds: z.array(uuid).max(200).default([]),
        defaultSiteId: uuid.nullable().default(null),
        autoCreate: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      const key = needKey();
      const p = provider(input.provider);
      const parsed = p.credentials.safeParse(input.credentials);
      if (!parsed.success)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Some of the sign-in details are missing or wrong',
        });
      await ownSites(ctx.orgId, [
        ...input.siteIds,
        ...(input.defaultSiteId ? [input.defaultSiteId] : []),
      ]);
      if (input.autoCreate && !input.defaultSiteId)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Pick the site new rooms should go to',
        });
      if (
        input.defaultSiteId &&
        input.siteIds.length &&
        !input.siteIds.includes(input.defaultSiteId)
      )
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The default site must be one of the sites it is limited to',
        });
      // A provider whose credentials rotate hands back the new ones while testing: those are the ones to keep.
      let rotated: Record<string, unknown> | null = null;
      try {
        await p.test(parsed.data, {
          ...realProviderDeps(),
          updateCredentials: async (next) => {
            rotated = next;
          },
        });
      } catch (e) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Those credentials did not work: ${e instanceof Error ? e.message : 'sign-in failed'}`,
        });
      }
      if (await db.integration.findFirst({ where: { orgId: ctx.orgId, name: input.name } }))
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'An integration with that name already exists',
        });
      // A vendor that calls us is given a secret to send, shown once and kept only as a hash.
      const secret = p.mode === 'push' ? generateSecret() : null;
      const created = await db.integration.create({
        data: {
          orgId: ctx.orgId,
          provider: p.id,
          name: input.name,
          siteIds: input.siteIds,
          defaultSiteId: input.defaultSiteId,
          autoCreate: input.autoCreate,
          sealed: seal(JSON.stringify(rotated ?? parsed.data), key),
          inboundHash: secret ? hashSecret(secret) : null,
          createdBy: ctx.user.id,
        },
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'integration.connect',
        target: created.id,
        meta: { provider: p.id, name: input.name },
      });
      return { id: created.id, secret };
    }),

  // Replaces the secret a vendor sends. The old one stops working at once; the new one is shown once.
  rotateSecret: proc.input(z.object({ orgId, id: uuid })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner']);
    const row = await db.integration.findFirst({ where: { id: input.id, orgId: ctx.orgId } });
    if (!row || getProvider(row.provider)?.mode !== 'push')
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Integration not found' });
    const secret = generateSecret();
    await db.integration.update({
      where: { id: row.id },
      data: { inboundHash: hashSecret(secret) },
    });
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: 'integration.rotate_secret',
      target: row.id,
      meta: { name: row.name },
    });
    return { secret };
  }),

  update: proc
    .input(
      z.object({
        orgId,
        id: uuid,
        name: name.optional(),
        enabled: z.boolean().optional(),
        siteIds: z.array(uuid).max(200).optional(),
        defaultSiteId: uuid.nullable().optional(),
        autoCreate: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      const row = await db.integration.findFirst({ where: { id: input.id, orgId: ctx.orgId } });
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Integration not found' });
      const siteIds = input.siteIds ?? row.siteIds;
      const defaultSiteId =
        input.defaultSiteId === undefined ? row.defaultSiteId : input.defaultSiteId;
      const autoCreate = input.autoCreate ?? row.autoCreate;
      await ownSites(ctx.orgId, [...siteIds, ...(defaultSiteId ? [defaultSiteId] : [])]);
      if (autoCreate && !defaultSiteId)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Pick the site new rooms should go to',
        });
      if (defaultSiteId && siteIds.length && !siteIds.includes(defaultSiteId))
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The default site must be one of the sites it is limited to',
        });
      if (input.name && input.name !== row.name) {
        const clash = await db.integration.findFirst({
          where: { orgId: ctx.orgId, name: input.name, NOT: { id: row.id } },
        });
        if (clash)
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'An integration with that name already exists',
          });
      }
      await db.integration.update({
        where: { id: row.id },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          siteIds,
          defaultSiteId,
          autoCreate,
        },
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'integration.update',
        target: row.id,
        meta: { name: input.name ?? row.name },
      });
      return { ok: true };
    }),

  // Devices keep what they last read; only the link goes.
  remove: proc.input(z.object({ orgId, id: uuid })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner']);
    const row = await db.integration.findFirst({ where: { id: input.id, orgId: ctx.orgId } });
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Integration not found' });
    await db.integration.delete({ where: { id: row.id } });
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: 'integration.remove',
      target: row.id,
      meta: { provider: row.provider, name: row.name },
    });
    return { ok: true };
  }),

  syncNow: proc.input(z.object({ orgId, id: uuid })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const row = await db.integration.findFirst({ where: { id: input.id, orgId: ctx.orgId } });
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Integration not found' });
    if (getProvider(row.provider)?.mode === 'push')
      return {
        ok: false,
        error:
          'This connection is updated by the vendor sending events, so there is nothing to read.',
        seen: 0,
        updated: 0,
        created: 0,
        skipped: 0,
      };
    const res = await syncIntegration(db, row, new Date());
    if (res.jobs.length) await queueAlerts(db, res.jobs);
    return {
      ok: res.ok,
      error: res.error ?? null,
      seen: res.seen,
      updated: res.updated,
      created: res.created,
      skipped: res.skipped,
    };
  }),

  // What the vendor can see, with which of it is already paired to a Kestrel device, for the pairing list.
  discover: proc.input(z.object({ orgId, id: uuid })).query(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const row = await db.integration.findFirst({ where: { id: input.id, orgId: ctx.orgId } });
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Integration not found' });
    const p = provider(row.provider);
    if (p.mode === 'push') return [];
    let found;
    try {
      const creds = p.credentials.parse(unsealCredentials(row, process.env.KESTREL_SECRETS_KEY));
      found = await p.list(creds, realProviderDeps());
    } catch (e) {
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message: e instanceof Error ? e.message : 'Could not read the vendor',
      });
    }
    const paired = await db.device.findMany({
      where: { orgId: ctx.orgId, integrationId: row.id },
      select: { id: true, externalId: true, name: true },
    });
    const byExt = new Map(paired.map((d) => [d.externalId, d]));
    return found.map((d) => ({
      externalId: d.externalId,
      name: d.name,
      roomName: d.roomName ?? null,
      model: d.model ?? null,
      online: d.online,
      pairedDeviceId: byExt.get(d.externalId)?.id ?? null,
      pairedDeviceName: byExt.get(d.externalId)?.name ?? null,
    }));
  }),

  // Pairs an existing Kestrel device with a vendor record. One vendor record, one device.
  pair: proc
    .input(z.object({ orgId, id: uuid, deviceId: uuid, externalId: z.string().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const row = await db.integration.findFirst({ where: { id: input.id, orgId: ctx.orgId } });
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Integration not found' });
      const device = await db.device.findFirst({ where: { id: input.deviceId, orgId: ctx.orgId } });
      if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });
      if (!inScope(row, device.siteId))
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'That device is at a site this integration is not limited to',
        });
      if (device.control)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'That device is already watched by a gateway. Pair a device without a driver, or add a new one',
        });
      const taken = await db.device.findFirst({
        where: { integrationId: row.id, externalId: input.externalId, NOT: { id: device.id } },
      });
      if (taken)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'That vendor record is already paired to another device',
        });
      await db.device.update({
        where: { id: device.id },
        data: { integrationId: row.id, externalId: input.externalId, kind: 'active' },
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'integration.pair',
        target: device.id,
        meta: { integration: row.name, externalId: input.externalId },
      });
      return { ok: true };
    }),

  unpair: proc.input(z.object({ orgId, deviceId: uuid })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const device = await db.device.findFirst({
      where: { id: input.deviceId, orgId: ctx.orgId, integrationId: { not: null } },
    });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'That device is not paired' });
    await db.device.update({
      where: { id: device.id },
      data: { integrationId: null, externalId: null, online: null },
    });
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: 'integration.unpair',
      target: device.id,
      meta: {},
    });
    return { ok: true };
  }),
});
