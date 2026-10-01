import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { seal } from '@kestrel/crypto';
import { writeAudit } from '../audit';
import { CalendarCredentials, testCredentials } from '../calendar';
import { refreshRoomNow, roomWeek } from '../room-calendar';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const name = z.string().trim().min(1).max(80);

const needKey = () => {
  const key = process.env.KESTREL_SECRETS_KEY;
  if (!key)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Calendar connections aren’t set up on this Kestrel server yet',
    });
  return key;
};

// Calendar profiles are secrets: they are sealed on the way in and never sent back out. An
// organisation can have several (two Microsoft 365 tenants, Google as well); each room picks one.
export const calendarRouter = router({
  list: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const [rows, rooms] = await Promise.all([
      db.calendarConnection.findMany({
        where: { orgId: ctx.orgId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, provider: true, name: true, createdAt: true },
      }),
      db.room.findMany({
        where: { orgId: ctx.orgId, calendarConnectionId: { not: null } },
        select: { calendarConnectionId: true },
      }),
    ]);
    return {
      connections: rows.map((c) => ({
        ...c,
        rooms: rooms.filter((r) => r.calendarConnectionId === c.id).length,
      })),
      available: !!process.env.KESTREL_SECRETS_KEY,
    };
  }),

  // Signs in once to prove the credentials work before saving them. With `connectionId` it
  // replaces that profile's credentials and name; without, it adds a new profile.
  connect: orgProcedure
    .input(
      z.object({
        orgId,
        name,
        credentials: CalendarCredentials,
        connectionId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      const key = needKey();
      try {
        await testCredentials(input.credentials);
      } catch (e) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Those credentials didn’t work: ${e instanceof Error ? e.message : 'sign-in failed'}`,
        });
      }
      const { provider, ...secret } = input.credentials;
      const sealed = seal(JSON.stringify(secret), key);
      const clash = await db.calendarConnection.findFirst({
        where: { orgId: ctx.orgId, name: input.name, NOT: { id: input.connectionId } },
      });
      if (clash)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A calendar profile with that name already exists',
        });
      let id: string;
      if (input.connectionId) {
        const existing = await db.calendarConnection.findFirst({
          where: { id: input.connectionId, orgId: ctx.orgId },
        });
        if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Profile not found' });
        if (existing.provider !== provider)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'A profile can’t change its calendar service. Add a new one instead',
          });
        await db.calendarConnection.update({
          where: { id: existing.id },
          data: { name: input.name, sealed },
        });
        id = existing.id;
      } else {
        id = (
          await db.calendarConnection.create({
            data: { orgId: ctx.orgId, provider, name: input.name, sealed },
          })
        ).id;
      }
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: input.connectionId ? 'calendar.update' : 'calendar.connect',
        target: id,
        meta: { provider, name: input.name },
      });
      return { ok: true, id };
    }),

  // Rooms that used the profile lose their calendar (their copy of the bookings goes with it).
  remove: orgProcedure
    .input(z.object({ orgId, connectionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      const c = await db.calendarConnection.findFirst({
        where: { id: input.connectionId, orgId: ctx.orgId },
      });
      if (!c) throw new TRPCError({ code: 'NOT_FOUND', message: 'Connection not found' });
      const using = await db.room.findMany({
        where: { orgId: ctx.orgId, calendarConnectionId: c.id },
        select: { id: true },
      });
      await db.roomSchedule.deleteMany({
        where: { orgId: ctx.orgId, roomId: { in: using.map((r) => r.id) } },
      });
      await db.room.updateMany({
        where: { orgId: ctx.orgId, calendarConnectionId: c.id },
        data: { calendarResource: null },
      });
      await db.calendarConnection.delete({ where: { id: c.id } });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'calendar.remove',
        target: c.id,
        meta: { provider: c.provider, name: c.name, rooms: using.length },
      });
      return { ok: true, rooms: using.length };
    }),

  // Which profile a room uses and its own calendar in it: the room mailbox address for Microsoft
  // 365, the calendar id for Google. Read once now, so a wrong address is caught here.
  setRoom: orgProcedure
    .input(
      z.object({
        orgId,
        roomId: z.string().uuid(),
        connectionId: z.string().uuid().nullable(),
        resource: z.string().trim().min(3).max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const room = await db.room.findFirst({ where: { id: input.roomId, orgId: ctx.orgId } });
      if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found' });
      if (input.connectionId === null) {
        await db.room.update({
          where: { id: room.id },
          data: { calendarConnectionId: null, calendarResource: null },
        });
        await db.roomSchedule.deleteMany({ where: { roomId: room.id, orgId: ctx.orgId } });
      } else {
        needKey();
        if (!input.resource)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Enter the room’s calendar (for Microsoft 365, its email address)',
          });
        const profile = await db.calendarConnection.findFirst({
          where: { id: input.connectionId, orgId: ctx.orgId },
        });
        if (!profile) throw new TRPCError({ code: 'NOT_FOUND', message: 'Profile not found' });
        try {
          await refreshRoomNow(db, room, profile.id, input.resource);
        } catch (e) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Couldn’t read that calendar: ${e instanceof Error ? e.message : 'unknown error'}`,
          });
        }
        await db.room.update({
          where: { id: room.id },
          data: { calendarConnectionId: profile.id, calendarResource: input.resource },
        });
      }
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'calendar.room',
        target: room.id,
        meta: { connectionId: input.connectionId },
      });
      return { ok: true };
    }),

  // A room's calendar profile and address (never the credentials), for its settings.
  forRoom: orgProcedure
    .input(z.object({ orgId, roomId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const room = await db.room.findFirst({
        where: { id: input.roomId, orgId: ctx.orgId },
        select: { calendarConnectionId: true, calendarResource: true },
      });
      if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found' });
      return room;
    }),

  // Monday to Sunday of the week holding `at` (default: this week), read live from the calendar.
  week: orgProcedure
    .input(z.object({ orgId, roomId: z.string().uuid(), at: z.coerce.date().optional() }))
    .query(async ({ ctx, input }) => {
      const room = await db.room.findFirst({ where: { id: input.roomId, orgId: ctx.orgId } });
      if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found' });
      return roomWeek(db, room, input.at ?? new Date());
    }),
});
