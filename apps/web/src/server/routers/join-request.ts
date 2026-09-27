import { after } from 'next/server';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { OrgRole } from '@kestrel/model';
import { notifyJoinRequest } from '../join-notify';
import {
  SignupError,
  cancelRequest,
  decideRequest,
  myRequests,
  pendingRequestCount,
  pendingRequests,
  personOf,
  requestToJoin,
} from '../org-signup';
import { authedProcedure, orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const requestId = z.string().uuid();

async function run<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (e) {
    if (e instanceof SignupError) throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
    throw e;
  }
}

// Someone from an owner's company asking to be added. The person asks (before they have an
// organisation of their own); the organisation's owners approve or decline.
export const joinRequestRouter = router({
  // ---- The person asking -------------------------------------------------------------------
  mine: authedProcedure.query(({ ctx }) => myRequests(db, ctx.user.id)),

  create: authedProcedure.input(z.object({ orgId })).mutation(async ({ ctx, input }) => {
    const person = personOf(ctx.user);
    const result = await run(requestToJoin(db, { person, orgId: input.orgId }));
    if (result.created)
      after(() =>
        notifyJoinRequest(db, {
          orgId: input.orgId,
          orgName: result.orgName,
          requesterEmail: person.email ?? '',
        }).catch((e) => console.error('[join] notification failed', e)),
      );
    return { id: result.id, orgName: result.orgName };
  }),

  cancel: authedProcedure
    .input(z.object({ requestId }))
    .mutation(({ ctx, input }) =>
      run(cancelRequest(db, { userId: ctx.user.id, requestId: input.requestId })).then(() => ({
        ok: true,
      })),
    ),

  // ---- The organisation's owners -----------------------------------------------------------
  list: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    requireRole(ctx.role, ['owner']);
    return pendingRequests(db, ctx.orgId);
  }),

  count: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    if (ctx.role !== 'owner') return 0;
    return pendingRequestCount(db, ctx.orgId);
  }),

  approve: orgProcedure
    .input(z.object({ orgId, requestId, role: OrgRole }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      await run(
        decideRequest(db, {
          orgId: ctx.orgId,
          requestId: input.requestId,
          by: ctx.user.id,
          decision: { approve: true, role: input.role },
        }),
      );
      return { ok: true };
    }),

  decline: orgProcedure
    .input(z.object({ orgId, requestId }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      await run(
        decideRequest(db, {
          orgId: ctx.orgId,
          requestId: input.requestId,
          by: ctx.user.id,
          decision: { approve: false },
        }),
      );
      return { ok: true };
    }),
});
