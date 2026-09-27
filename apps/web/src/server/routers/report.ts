import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { writeAudit } from '../audit';
import { buildMonthlyReport, currentMonth } from '../monthly-report';
import {
  MAX_REPORT_RECIPIENTS,
  emailConfigured,
  sendReportEmail,
} from '../report-delivery';
import { featureProcedure, requireRole, router } from '../trpc';
import { validTimeZone } from '../usage-analytics';

// Monthly customer reports. Not site-scoped, so a provider limited to some sites cannot open them:
// they cover the whole organisation.
const orgId = z.string().uuid();
const tz = z.string().max(64).default('UTC');
const month = z.object({ year: z.number().int().min(2024).max(2100), month: z.number().int().min(1).max(12) });
const reports = featureProcedure('analytics');

function checkMonth(m: { year: number; month: number }, zone: string) {
  if (!validTimeZone(zone)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown time zone' });
  const latest = currentMonth(new Date(), zone);
  // The month under way is allowed (reported up to now); later ones are not.
  if (m.year * 12 + m.month > latest.year * 12 + latest.month)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'That month has not started yet' });
}

const email = z.string().trim().toLowerCase().email().max(200);

export const reportRouter = router({
  monthly: reports
    .input(z.object({ orgId, tz, ...month.shape }))
    .query(async ({ ctx, input }) => {
      checkMonth(input, input.tz);
      return buildMonthlyReport(db, ctx.orgId, { year: input.year, month: input.month }, input.tz);
    }),

  // Email the report to the person asking, so they can forward it on.
  emailMe: reports
    .input(z.object({ orgId, tz, ...month.shape }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      checkMonth(input, input.tz);
      if (!emailConfigured()) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Email is not set up on this Kestrel server' });
      if (!ctx.user.email) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Your account has no email address' });
      const report = await buildMonthlyReport(db, ctx.orgId, { year: input.year, month: input.month }, input.tz);
      await sendReportEmail({ fetch, env: process.env }, [ctx.user.email], ctx.orgId, report);
      return { sentTo: ctx.user.email };
    }),

  schedule: reports.input(z.object({ orgId })).query(async ({ ctx }) => {
    requireRole(ctx.role, ['owner']);
    const s = await db.reportSchedule.findFirst({ where: { orgId: ctx.orgId } });
    return {
      enabled: s?.enabled ?? false,
      recipients: s?.recipients ?? [],
      timezone: s?.timezone ?? 'UTC',
      lastSentMonth: s?.lastSentMonth ?? null,
      emailReady: emailConfigured(),
    };
  }),

  setSchedule: reports
    .input(
      z.object({
        orgId,
        enabled: z.boolean(),
        recipients: z.array(email).max(MAX_REPORT_RECIPIENTS),
        timezone: z.string().max(64),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner']);
      if (!validTimeZone(input.timezone)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown time zone' });
      const recipients = [...new Set(input.recipients)];
      if (input.enabled && recipients.length === 0)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Add at least one email address' });
      const data = { enabled: input.enabled, recipients, timezone: input.timezone, updatedBy: ctx.user.id };
      await db.reportSchedule.upsert({
        where: { orgId: ctx.orgId },
        create: { orgId: ctx.orgId, ...data },
        update: data,
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'report.schedule',
        target: ctx.orgId,
        meta: { enabled: input.enabled, recipients: recipients.length },
      });
      return { ok: true };
    }),
});
