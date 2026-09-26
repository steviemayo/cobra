import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { PointAddress, PointType, RoomModel, type CustomDrivers } from '@kestrel/model';
import { writeAudit } from '../audit';
import {
  type DeviceBindingChange,
  bindingView,
  createCredentialSet,
  deleteCredentialSet,
  listCredentialSets,
  saveDeviceBinding,
  saveDeviceBindings,
  updateCredentialSet,
} from '../bindings';
import { requestCommand } from '../commands';
import { pinDrivers } from '../custom-drivers';
import { orgProcedure, requireRole, router } from '../trpc';
import { assertRoom } from './room-model-helpers';

const orgId = z.string().uuid();
const roomInput = z.object({ orgId, roomId: z.string().uuid() });
const value = z.union([z.string().max(2000), z.number()]);
const fields = z
  .record(z.string().min(1).max(60), z.string().max(2000))
  .refine((f) => Object.keys(f).length <= 20, { message: 'Too many fields' });

/** The room's saved design and the custom drivers it uses, or a clear error when it has no design yet. */
async function loadDesign(ctxOrgId: string, roomId: string) {
  const room = await assertRoom(ctxOrgId, roomId);
  const draft = await db.roomDraft.findFirst({ where: { roomId: room.id, orgId: ctxOrgId } });
  if (!draft) throw new TRPCError({ code: 'NOT_FOUND', message: 'Design this room first' });
  const model = RoomModel.parse(draft.model);
  const pinned = await pinDrivers(db, ctxOrgId, model);
  const custom: CustomDrivers = pinned.ok ? pinned.drivers : {};
  return { room, model, custom };
}

function fail(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}

// Addresses and logins for a room's devices, and the credential sets they can share. Logins are
// write-only: nothing here ever sends one to a browser.
export const bindingRouter = router({
  view: orgProcedure.input(roomInput).query(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev', 'support']);
    const { room, model, custom } = await loadDesign(ctx.orgId, input.roomId);
    const view = await bindingView(db, { orgId: ctx.orgId, roomId: room.id, model, custom });
    return {
      ...view,
      hasGateway: !!room.gatewayId,
      /** What the gateway is running with, for a "binding pending" note. Null: not reported. */
      reportedVersion: room.reportedBindingsVersion,
      canStoreLogins: !!process.env.KESTREL_SECRETS_KEY,
    };
  }),

  saveDevice: orgProcedure
    .input(
      roomInput.extend({
        deviceId: z.string().min(1).max(100),
        set: z.record(z.string().min(1).max(60), value).optional(),
        credentialSetId: z.string().uuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const { room, model, custom } = await loadDesign(ctx.orgId, input.roomId);
      const device = model.devices.find((d) => d.id === input.deviceId);
      if (!device) return fail('That device is not in this room’s design');
      const res = await saveDeviceBinding(db, {
        orgId: ctx.orgId,
        roomId: room.id,
        device,
        custom,
        ...(input.set ? { set: input.set } : {}),
        ...(input.credentialSetId !== undefined ? { credentialSetId: input.credentialSetId } : {}),
        userId: ctx.user.id,
      });
      if (!res.ok) return fail(res.message);
      // Names only: never the values, which may be logins.
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'room.bindings',
        target: room.id,
        meta: {
          room: room.name,
          device: device.name,
          changed: Object.keys(input.set ?? {}),
          ...(input.credentialSetId !== undefined ? { credentialSet: input.credentialSetId } : {}),
        },
      });
      return { version: res.version };
    }),

  // Many devices at once, from the settings table: one new version for the room, and nothing is
  // saved unless every change is allowed.
  saveDevices: orgProcedure
    .input(
      roomInput.extend({
        changes: z
          .array(
            z.object({
              deviceId: z.string().min(1).max(100),
              set: z.record(z.string().min(1).max(60), value).optional(),
              credentialSetId: z.string().uuid().nullable().optional(),
            }),
          )
          .min(1)
          .max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const { room, model, custom } = await loadDesign(ctx.orgId, input.roomId);
      const changes: DeviceBindingChange[] = [];
      for (const c of input.changes) {
        const device = model.devices.find((d) => d.id === c.deviceId);
        if (!device) return fail('A device in this change is not in this room’s design');
        changes.push({
          device,
          ...(c.set ? { set: c.set } : {}),
          ...(c.credentialSetId !== undefined ? { credentialSetId: c.credentialSetId } : {}),
        });
      }
      const res = await saveDeviceBindings(db, {
        orgId: ctx.orgId,
        roomId: room.id,
        custom,
        changes,
        userId: ctx.user.id,
      });
      if (!res.ok) return fail(res.message);
      // Names only: never the values, which may be logins.
      for (const c of changes)
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'room.bindings',
          target: room.id,
          meta: {
            room: room.name,
            device: c.device.name,
            changed: Object.keys(c.set ?? {}),
            ...(c.credentialSetId !== undefined ? { credentialSet: c.credentialSetId } : {}),
          },
        });
      return { version: res.version, devices: changes.length };
    }),

  // Ask the room's gateway whether a device answers. It tests what the room is running now, so
  // save the new address and let the gateway pick it up first.
  test: orgProcedure
    .input(roomInput.extend({ deviceId: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const res = await requestCommand(db, {
        orgId: ctx.orgId,
        roomId: input.roomId,
        type: 'test_device',
        args: { deviceId: input.deviceId },
        requestedBy: ctx.user.id,
      });
      if (!res.ok) return fail(res.error);
      return { commandId: res.id };
    }),

  testResult: orgProcedure
    .input(roomInput.extend({ commandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const row = await db.remoteCommand.findFirst({
        where: { id: input.commandId, orgId: ctx.orgId, roomId: input.roomId },
      });
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Test not found' });
      return {
        status: row.status,
        error: row.error,
        output: (row.output ?? null) as Record<string, unknown> | null,
      };
    }),

  // Ask the room's gateway to read one control point of a DSP, to check it exists and learn its
  // range. Like Test connection it needs the room running, and the address is sent with the request.
  verifyPoint: orgProcedure
    .input(
      roomInput.extend({
        deviceId: z.string().min(1).max(100),
        type: PointType,
        address: PointAddress,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const res = await requestCommand(db, {
        orgId: ctx.orgId,
        roomId: input.roomId,
        type: 'verify_point',
        args: { deviceId: input.deviceId, type: input.type, address: JSON.stringify(input.address) },
        requestedBy: ctx.user.id,
      });
      if (!res.ok) return fail(res.error);
      return { commandId: res.id };
    }),

  credentialSets: router({
    list: orgProcedure.input(z.object({ orgId })).query(({ ctx }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      return listCredentialSets(db, ctx.orgId);
    }),

    create: orgProcedure
      .input(z.object({ orgId, name: z.string().trim().min(1).max(80), fields }))
      .mutation(async ({ ctx, input }) => {
        requireRole(ctx.role, ['owner', 'dev']);
        const res = await createCredentialSet(db, {
          orgId: ctx.orgId,
          name: input.name,
          fields: input.fields,
          userId: ctx.user.id,
        });
        if (!res.ok) return fail(res.message);
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'credentials.create',
          target: res.id,
          meta: { name: input.name, fields: Object.keys(input.fields) },
        });
        return { id: res.id };
      }),

    update: orgProcedure
      .input(
        z.object({
          orgId,
          id: z.string().uuid(),
          name: z.string().trim().min(1).max(80).optional(),
          fields: fields.optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireRole(ctx.role, ['owner', 'dev']);
        const res = await updateCredentialSet(db, {
          orgId: ctx.orgId,
          id: input.id,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.fields ? { fields: input.fields } : {}),
          userId: ctx.user.id,
        });
        if (!res.ok) return fail(res.message);
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'credentials.update',
          target: input.id,
          meta: { changed: Object.keys(input.fields ?? {}), rooms: res.roomsUpdated ?? 0 },
        });
        return { roomsUpdated: res.roomsUpdated ?? 0 };
      }),

    delete: orgProcedure
      .input(z.object({ orgId, id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        requireRole(ctx.role, ['owner', 'dev']);
        const res = await deleteCredentialSet(db, ctx.orgId, input.id);
        if (!res.ok) return fail(res.message);
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'credentials.delete',
          target: input.id,
        });
        return { ok: true };
      }),
  }),
});
