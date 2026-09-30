import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { writeAudit } from '../audit';
import {
  PM_REPORT_PURPOSE,
  REGISTER_PURPOSE,
  buildRegisterRows,
  checkDocument,
  issueRegister,
  registerCsv,
  setSchedule,
  type RegisterRow,
} from '../register-issues';
import { importRegister } from '../register-import';
import { loadSigningKey, trustedPublicKeys } from '../signing';
import { featureProcedure, orgProcedure, requireRole, router } from '../trpc';

// Signed register issues are a Pro feature (and part of a running trial). The register, its CSV export and import are on every plan.
const signed = featureProcedure('registerIssues');

const orgId = z.string().uuid();
const id = z.string().uuid();
const TEAM = ['owner', 'dev', 'support'] as const;

function fail(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}

// Register issues (signed, numbered copies of the asset register), CSV import and export.
export const registerRouter = router({
  /** Issued copies, newest first. The signed content is fetched one at a time. */
  issues: signed
    .input(z.object({ orgId, kind: z.enum(['register', 'pm_report']).default('register') }))
    .query(async ({ ctx, input }) => {
      const rows = await db.registerIssue.findMany({
        where: { orgId: ctx.orgId, kind: input.kind },
        orderBy: { takenAt: 'desc' },
        take: 100,
        select: {
          id: true,
          number: true,
          kind: true,
          scope: true,
          scopeId: true,
          title: true,
          takenAt: true,
          takenBy: true,
          hash: true,
          keyId: true,
        },
      });
      return rows;
    }),

  /** One issue, whole, with whether its signature checks out today. */
  issue: signed.input(z.object({ orgId, issueId: id })).query(async ({ ctx, input }) => {
    const row = await db.registerIssue.findFirst({
      where: { id: input.issueId, orgId: ctx.orgId },
    });
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such issue' });
    const purpose = row.kind === 'pm_report' ? PM_REPORT_PURPOSE : REGISTER_PURPOSE;
    return {
      id: row.id,
      number: row.number,
      kind: row.kind,
      title: row.title,
      takenAt: row.takenAt,
      document: row.payload,
      verified: checkDocument(row.payload, purpose, trustedPublicKeys()),
    };
  }),

  /** Freezes and signs the register as it is now. */
  issue_now: signed
    .input(
      z.object({
        orgId,
        scope: z.enum(['org', 'site', 'area']).default('org'),
        scopeId: id.nullable().optional(),
        title: z.string().trim().max(120).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      let key;
      try {
        key = loadSigningKey();
      } catch {
        return fail('The server has no signing key configured yet');
      }
      const res = await issueRegister(db, { ...input, orgId: ctx.orgId, userId: ctx.user.id }, key);
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'register.issue',
        target: res.value.id,
        meta: { number: res.value.number, scope: input.scope },
      });
      return res.value;
    }),

  /** How often an issue is taken by itself (null: never). */
  schedule: signed.input(z.object({ orgId })).query(async ({ ctx }) => {
    const s = await db.registerSchedule.findFirst({ where: { orgId: ctx.orgId } });
    return { everyDays: s?.everyDays ?? null, lastIssuedAt: s?.lastIssuedAt ?? null };
  }),

  setSchedule: signed
    .input(z.object({ orgId, everyDays: z.number().int().nullable() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const res = await setSchedule(db, ctx.orgId, input.everyDays);
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'register.schedule',
        meta: { everyDays: input.everyDays },
      });
      return res.value;
    }),

  /** The register as CSV, for the whole organisation or a site. */
  csv: orgProcedure
    .input(z.object({ orgId, siteId: id.optional() }))
    .query(async ({ ctx, input }) => {
      const rows: RegisterRow[] = await buildRegisterRows(
        db,
        ctx.orgId,
        input.siteId ? 'site' : 'org',
        input.siteId ?? null,
      );
      return {
        filename: `asset-register-${new Date().toISOString().slice(0, 10)}.csv`,
        body: registerCsv(rows),
      };
    }),

  /** Reads a spreadsheet into the register. `dryRun` shows what it would do without changing anything. */
  import: orgProcedure
    .input(
      z.object({
        orgId,
        siteId: id,
        csv: z.string().max(2_000_000),
        dryRun: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      const res = await importRegister(db, { ...input, orgId: ctx.orgId, userId: ctx.user.id });
      if (!input.dryRun && res.errors.length === 0)
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'register.import',
          meta: { created: res.created, updated: res.updated },
        });
      return res;
    }),
});
