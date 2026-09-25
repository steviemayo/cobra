import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { orgDetail, orgDirectory, recordStaffAudit, mfaRequired } from '../staff';
import {
  LicenceError,
  addNote,
  licenceState,
  listNotes,
  revokeOverride,
  setOverride,
} from '../staff-licences';
import {
  requireAnyStaffRole,
  requireStaffRole,
  router,
  staffIdentityProcedure,
  staffProcedure,
} from '../trpc';

function asTrpc(e: unknown): never {
  if (e instanceof LicenceError) throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
  throw e;
}

const orgId = z.string().uuid();

// Everything under /staff. These procedures are not limited to one organisation: they only exist
// for Kestrel staff, and anything that reads a customer's organisation is written to the staff
// audit trail.
export const staffRouter = router({
  // Who the signed-in staff member is, and whether they still need to verify a second factor.
  me: staffIdentityProcedure.query(({ ctx }) => ({
    email: ctx.staff.email,
    roles: ctx.staff.roles,
    mfaRequired: mfaRequired(),
    mfaSatisfied: ctx.mfaSatisfied,
  })),

  // Licences and trials: what an organisation pays for, what it may do, and staff adjustments.
  licence: router({
    get: staffProcedure
      .input(z.object({ orgId }))
      .query(({ input }) => licenceState(db, input.orgId)),

    set: staffProcedure
      .input(
        z.object({
          orgId,
          plan: z.enum(['trial', 'basic', 'pro']).nullish(),
          trialEndsAt: z.date().nullish(),
          maxRooms: z.number().int().nullish(),
          unlimitedRooms: z.boolean().optional(),
          monitoring: z.boolean().nullish(),
          expiresAt: z.date().nullish(),
          reason: z.string().max(600),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireStaffRole(ctx.staff, 'billing');
        const { orgId: id, ...rest } = input;
        try {
          return await setOverride(db, { orgId: id, staffUserId: ctx.staff.userId, input: rest });
        } catch (e) {
          return asTrpc(e);
        }
      }),

    revoke: staffProcedure
      .input(z.object({ orgId, overrideId: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        requireStaffRole(ctx.staff, 'billing');
        try {
          await revokeOverride(db, { ...input, staffUserId: ctx.staff.userId });
          return { ok: true };
        } catch (e) {
          return asTrpc(e);
        }
      }),
  }),

  notes: router({
    list: staffProcedure
      .input(z.object({ orgId }))
      .query(({ input }) => listNotes(db, input.orgId)),

    add: staffProcedure
      .input(z.object({ orgId, body: z.string().max(2100) }))
      .mutation(async ({ ctx, input }) => {
        requireAnyStaffRole(ctx.staff, ['support', 'billing']);
        try {
          await addNote(db, { orgId: input.orgId, authorId: ctx.staff.userId, body: input.body });
          return { ok: true };
        } catch (e) {
          return asTrpc(e);
        }
      }),
  }),

  orgs: router({
    // One row per organisation. Counts only, so it is not audited.
    list: staffProcedure.query(() => orgDirectory(db)),

    get: staffProcedure
      .input(z.object({ orgId: z.string().uuid() }))
      .query(async ({ ctx, input }) => {
        const detail = await orgDetail(db, input.orgId);
        if (!detail) throw new TRPCError({ code: 'NOT_FOUND', message: 'Organisation not found' });
        await recordStaffAudit(db, {
          staffUserId: ctx.staff.userId,
          action: 'org.view',
          orgId: input.orgId,
        });
        return detail;
      }),
  }),
});
