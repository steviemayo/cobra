import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import {
  ADDRESS_MODES,
  AssetCategory,
  AssetStatus,
  ControlPoint,
  DeviceControl,
  DeviceKind,
} from '@kestrel/model';
import { writeAudit } from '../audit';
import {
  alignDates,
  createDevice,
  deleteDevice,
  resolveSwap,
  updateDevice,
  type DeviceInput,
} from '../devices';
import { AddressError, requestRefind, useAddress } from '../address-tracking';
import { deviceViews } from '../device-views';
import { setDeviceRooms } from '../device-sharing';
import { MAX_POINTS, setDevicePoints } from '../device-points';
import { canMonitorRoom, getEntitlements, monitoredRoomIds, monitorLimitMessage } from '../billing';
import { syncQuantity } from '../stripe';
import { after } from 'next/server';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const id = z.string().uuid();
const text = (n: number) => z.string().trim().max(n);
const optText = (n: number) => text(n).nullable().optional();
const date = z.coerce.date().nullable().optional();
const fields = z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()]));

/** A room is charged once it has a monitored device: refuse a device that would take the organisation over its plan. */
async function checkMonitorLimit(orgIdValue: string, roomId: string | null | undefined) {
  const e = await getEntitlements(db, orgIdValue);
  if (!(await canMonitorRoom(db, orgIdValue, e, roomId ?? null)))
    throw new TRPCError({ code: 'FORBIDDEN', message: monitorLimitMessage(e) });
}

function fail(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}

const patchShape = {
  name: text(80).min(1).optional(),
  category: AssetCategory.optional(),
  roomId: id.nullable().optional(),
  gatewayId: id.nullable().optional(),
  control: DeviceControl.optional(),
  settings: fields.optional(),
  values: fields.optional(),
  secrets: fields.optional(),
  credentialSetId: id.nullable().optional(),
  status: AssetStatus.optional(),
  assetTag: optText(80),
  installedOn: date,
  warrantyEndsOn: date,
  endOfLifeOn: date,
  supplier: optText(200),
  notes: optText(2000),
  make: optText(100),
  model: optText(100),
  serial: optText(100),
  mac: optText(40),
  ip: optText(80),
  firmware: optText(100),
  addressMode: z.enum(ADDRESS_MODES).optional(),
  hostname: optText(253),
};

// Devices, active and passive (docs/pivot-monitoring.md). Logins are write-only: a browser only
// learns whether one is set.
export const deviceRouter = router({
  list: orgProcedure
    .input(z.object({ orgId, siteId: id.optional(), roomId: id.optional(), areaId: id.optional() }))
    .query(({ ctx, input }) => deviceViews(db, { ...input, orgId: ctx.orgId })),

  get: orgProcedure.input(z.object({ orgId, deviceId: id })).query(async ({ ctx, input }) => {
    const [view] = await deviceViews(db, { orgId: ctx.orgId, deviceId: input.deviceId });
    if (!view) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such device' });
    return view;
  }),

  /**
   * Replaces the control points read on a monitored device: named components and named controls on
   * a DSP, and what each is watched for. The gateway picks the change up in its next device set.
   */
  setPoints: orgProcedure
    .input(z.object({ orgId, deviceId: id, points: z.array(ControlPoint).max(MAX_POINTS) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const res = await setDevicePoints(db, {
        orgId: ctx.orgId,
        deviceId: input.deviceId,
        actorId: ctx.user.id,
        points: input.points,
      });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'device.points',
        target: input.deviceId,
        meta: { count: input.points.length },
      });
      return { ok: true };
    }),

  /**
   * Sets which other rooms a device serves (a shared device: one DSP or control system for several
   * rooms, possibly at different sites of the organisation). Replaces the list.
   */
  setRooms: orgProcedure
    .input(z.object({ orgId, deviceId: id, roomIds: z.array(id).max(50) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      // Linking a monitored device to a room makes that room monitored, which can take the
      // organisation over its plan.
      const shared = await db.device.findFirst({ where: { id: input.deviceId, orgId: ctx.orgId } });
      if (shared?.kind === 'active') {
        const have = new Set(
          (await db.deviceRoom.findMany({ where: { orgId: ctx.orgId, deviceId: shared.id } })).map(
            (l) => l.roomId,
          ),
        );
        const e = await getEntitlements(db, ctx.orgId);
        if (e.maxRooms !== null) {
          const current = await monitoredRoomIds(db, ctx.orgId);
          const fresh = new Set(
            input.roomIds.filter((r) => r !== shared.roomId && !have.has(r) && !current.has(r)),
          );
          if (current.size + fresh.size > e.maxRooms)
            throw new TRPCError({ code: 'FORBIDDEN', message: monitorLimitMessage(e) });
        }
      }
      const res = await setDeviceRooms(db, {
        orgId: ctx.orgId,
        deviceId: input.deviceId,
        roomIds: input.roomIds,
        actorId: ctx.user.id,
      });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'device.shared',
        target: input.deviceId,
        meta: { rooms: res.rooms },
      });
      after(() => syncQuantity(db, ctx.orgId).catch(() => undefined));
      return res;
    }),

  /** A person picks the address of a tracked device (one the gateway suggested, or typed). The gateway is told to use it. */
  useAddress: orgProcedure
    .input(z.object({ orgId, deviceId: id, address: text(253).min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      try {
        await useAddress(db, {
          orgId: ctx.orgId,
          deviceId: input.deviceId,
          address: input.address,
          actorId: ctx.user.id,
        });
      } catch (e) {
        if (e instanceof AddressError) return fail(e.message);
        throw e;
      }
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'device.use_address',
        target: input.deviceId,
        meta: { address: input.address },
      });
      return { ok: true };
    }),

  /** "Find again": the gateway looks for a tracked device at once. */
  findAgain: orgProcedure
    .input(z.object({ orgId, deviceId: id }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      try {
        await requestRefind(db, { orgId: ctx.orgId, deviceId: input.deviceId });
      } catch (e) {
        if (e instanceof AddressError) return fail(e.message);
        throw e;
      }
      return { ok: true };
    }),

  /** The device's history, newest first. */
  events: orgProcedure
    .input(z.object({ orgId, deviceId: id, limit: z.number().int().min(1).max(500).default(100) }))
    .query(async ({ ctx, input }) => {
      const device = await db.device.findFirst({ where: { id: input.deviceId, orgId: ctx.orgId } });
      if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such device' });
      return db.deviceEvent.findMany({
        where: { deviceId: input.deviceId, orgId: ctx.orgId },
        orderBy: { at: 'desc' },
        take: input.limit,
      });
    }),

  /** Incidents raised against this device (open and closed), newest first. */
  incidents: orgProcedure.input(z.object({ orgId, deviceId: id })).query(async ({ ctx, input }) => {
    const device = await db.device.findFirst({ where: { id: input.deviceId, orgId: ctx.orgId } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such device' });
    return db.incident.findMany({
      where: { orgId: ctx.orgId, subject: { startsWith: `device:${input.deviceId}` } },
      orderBy: { openedAt: 'desc' },
      take: 50,
    });
  }),

  /** Tickets about this device, newest first: its repair history. */
  tickets: orgProcedure.input(z.object({ orgId, deviceId: id })).query(async ({ ctx, input }) => {
    const device = await db.device.findFirst({ where: { id: input.deviceId, orgId: ctx.orgId } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such device' });
    return db.ticket.findMany({
      where: { orgId: ctx.orgId, deviceId: input.deviceId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        createdAt: true,
        closedAt: true,
        rootCause: true,
      },
    });
  }),

  create: orgProcedure
    .input(
      z.object({
        ...patchShape,
        orgId,
        siteId: id,
        kind: DeviceKind,
        name: text(80).min(1),
        category: AssetCategory,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      if (input.kind === 'active') await checkMonitorLimit(ctx.orgId, input.roomId);
      const res = await createDevice(db, {
        ...(input as unknown as DeviceInput),
        orgId: ctx.orgId,
        siteId: input.siteId,
        kind: input.kind,
        name: input.name,
        category: input.category,
        actorId: ctx.user.id,
      });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'device.create',
        target: res.value.id,
        meta: { name: input.name, kind: input.kind, category: input.category },
      });
      if (input.kind === 'active') after(() => syncQuantity(db, ctx.orgId).catch(() => undefined));
      return res.value;
    }),

  update: orgProcedure
    .input(z.object({ ...patchShape, orgId, deviceId: id }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const { deviceId, ...withOrg } = input;
      const patch: Record<string, unknown> = { ...withOrg };
      delete patch.orgId;
      // Adding a driver (or moving a monitored device into a room) can start charging for a room.
      const current = await db.device.findFirst({ where: { id: deviceId, orgId: ctx.orgId } });
      if (current && (input.control !== undefined || input.roomId !== undefined)) {
        const willBeActive = current.kind === 'active' || input.control !== undefined;
        if (willBeActive)
          await checkMonitorLimit(
            ctx.orgId,
            input.roomId === undefined ? current.roomId : input.roomId,
          );
      }
      const res = await updateDevice(db, {
        orgId: ctx.orgId,
        deviceId,
        actorId: ctx.user.id,
        patch: patch as unknown as DeviceInput,
      });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'device.update',
        target: deviceId,
      });
      after(() => syncQuantity(db, ctx.orgId).catch(() => undefined));
      return res.value;
    }),

  /**
   * Sets install, warranty-end and end-of-life dates on every device in a room, a site or the whole
   * organisation. Blanks only unless `overwrite` is set.
   */
  alignDates: orgProcedure
    .input(
      z.object({
        orgId,
        scope: z.enum(['org', 'site', 'room']),
        scopeId: id.nullable(),
        installedOn: z.coerce.date().optional(),
        warrantyEndsOn: z.coerce.date().optional(),
        endOfLifeOn: z.coerce.date().optional(),
        overwrite: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const res = await alignDates(db, {
        ...input,
        orgId: ctx.orgId,
        actorId: ctx.user.id,
      });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'device.align_dates',
        target: input.scopeId ?? ctx.orgId,
        meta: { scope: input.scope, overwrite: input.overwrite, ...res.value },
      });
      return res.value;
    }),

  /** "The serial changed": replaced (the old identity is retired) or a correction (no swap). */
  resolveSwap: orgProcedure
    .input(
      z.object({
        orgId,
        deviceId: id,
        outcome: z.enum(['replaced', 'correction']),
        note: text(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const res = await resolveSwap(db, {
        orgId: ctx.orgId,
        deviceId: input.deviceId,
        outcome: input.outcome,
        actorId: ctx.user.id,
        note: input.note,
      });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: `device.swap_${input.outcome}`,
        target: input.deviceId,
      });
      return res.value;
    }),

  delete: orgProcedure.input(z.object({ orgId, deviceId: id })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const res = await deleteDevice(db, ctx.orgId, input.deviceId);
    if (!res.ok) return fail(res.message);
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: 'device.delete',
      target: input.deviceId,
    });
    after(() => syncQuantity(db, ctx.orgId).catch(() => undefined));
    return res.value;
  }),
});
