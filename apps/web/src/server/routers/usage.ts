import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { SITE_SCOPED, inScope, siteFilter } from '../site-scope';
import { featureProcedure, router } from '../trpc';
import { loadUsageReport, validTimeZone } from '../usage-analytics';

// Usage and occupancy reports, from the telemetry the gateways send. Part of monitoring.
export const usageRouter = router({
  report: featureProcedure('monitoring')
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId: z.string().uuid(),
        /** Only this site's rooms. */
        siteId: z.string().uuid().optional(),
        days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30),
        /** The viewer's time zone, so business hours and days of the week read as they do locally. */
        tz: z.string().max(64).default('UTC'),
        businessStartHour: z.number().int().min(0).max(23).default(8),
        businessEndHour: z.number().int().min(1).max(24).default(18),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (!validTimeZone(input.tz))
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown time zone' });
      if (input.businessEndHour <= input.businessStartHour)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Business hours must end after they start' });
      const to = new Date();
      const from = new Date(to.getTime() - input.days * 86_400_000);
      return loadUsageReport(
        db,
        ctx.orgId,
        {
          from,
          to,
          tz: input.tz,
          businessStartHour: input.businessStartHour,
          businessEndHour: input.businessEndHour,
        },
        // A site the caller cannot see gives no rooms, not an error that would confirm it exists.
        input.siteId
          ? inScope(ctx.siteScope, input.siteId)
            ? { siteId: input.siteId }
            : { id: { in: [] } }
          : siteFilter(ctx.siteScope),
      );
    }),
});
