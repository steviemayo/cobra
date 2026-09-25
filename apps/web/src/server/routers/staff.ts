import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { orgDetail, orgDirectory, recordStaffAudit, mfaRequired } from '../staff';
import { router, staffIdentityProcedure, staffProcedure } from '../trpc';

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
