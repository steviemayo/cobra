import { db } from '@kestrel/db';
import { recordAcceptance } from '../legal';
import { authedProcedure, router } from '../trpc';

export const legalRouter = router({
  // Accept the current Terms and Privacy Policy, when asked again after the text changed (LR-5).
  accept: authedProcedure.mutation(async ({ ctx }) => {
    await recordAcceptance(db, { userId: ctx.user.id, source: 'gate' });
    return { ok: true };
  }),
});
