import 'server-only';
import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { z } from 'zod';
import { db } from '@kestrel/db';
import { hasStaffRole, type Feature, type OrgRole, type StaffRole } from '@kestrel/model';
import { createSupabaseServer } from '@/lib/supabase/server';
import { getEntitlements, planRequired } from './billing';
import { findStaff, mfaRequired } from './staff';
import { activeSession, logSessionAction, sessionGate } from './support-sessions';

export async function createContext() {
  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getUser();
  return { user: data.user };
}

const t = initTRPC.context<Awaited<ReturnType<typeof createContext>>>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { user: ctx.user } });
});

const orgInput = z.object({ orgId: z.string().uuid() });

// Every org-scoped procedure goes through here: verifies membership, exposes orgId + role.
// Prisma bypasses Supabase RLS, so all queries MUST filter by ctx.orgId.
export const orgProcedure = authedProcedure.use(async ({ ctx, next, getRawInput, type, path }) => {
  const parsed = orgInput.safeParse(await getRawInput());
  if (!parsed.success) throw new TRPCError({ code: 'BAD_REQUEST', message: 'orgId required' });
  const member = await db.member.findUnique({
    where: { orgId_userId: { orgId: parsed.data.orgId, userId: ctx.user.id } },
  });
  if (member) {
    const viewAs: ViewAs | null = null;
    return next({ ctx: { orgId: member.orgId, role: member.role as OrgRole, viewAs } });
  }

  // Not a member. Kestrel staff with an open support session (and a second factor) may work here,
  // at support level. A read session cannot change anything; an act session can, and every change
  // is logged against the session.
  const staff = await findStaff(db, ctx.user.id);
  const session = staff ? await activeSession(db, ctx.user.id, parsed.data.orgId) : null;
  if (!staff || !session) throw new TRPCError({ code: 'FORBIDDEN' });
  if (mfaRequired()) {
    const supabase = await createSupabaseServer();
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (data?.currentLevel !== 'aal2')
      throw new TRPCError({ code: 'FORBIDDEN', message: 'MFA_REQUIRED' });
  }
  const gate = sessionGate(session.mode, type);
  if (gate === 'deny') {
    await logSessionAction(db, session, 'session.blocked', path);
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This is a view-only support session. Start an "act" session to make changes.',
    });
  }
  if (gate === 'log') await logSessionAction(db, session, 'session.act', path);
  const viewAs: ViewAs = { sessionId: session.id, mode: session.mode, endsAt: session.endsAt };
  return next({ ctx: { orgId: parsed.data.orgId, role: 'support' as OrgRole, viewAs } });
});

/** Set when the caller is Kestrel staff working inside the organisation through a support session. */
export interface ViewAs {
  sessionId: string;
  mode: 'read' | 'act';
  endsAt: Date;
}

export function requireRole(role: OrgRole, allowed: OrgRole[]) {
  if (!allowed.includes(role))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Insufficient role' });
}

/** An org procedure that also needs the organisation's plan to include a feature. */
export const featureProcedure = (feature: Feature) =>
  orgProcedure.use(async ({ ctx, next }) => {
    const entitlements = await getEntitlements(db, ctx.orgId);
    if (!entitlements[feature])
      throw new TRPCError({ code: 'FORBIDDEN', message: planRequired(feature) });
    return next();
  });

/**
 * Kestrel staff, signed in but with no second factor check yet. Used by the staff shell to decide
 * where to send someone. Not scoped to an organisation. Anyone else gets FORBIDDEN.
 */
export const staffIdentityProcedure = authedProcedure.use(async ({ ctx, next }) => {
  const staff = await findStaff(db, ctx.user.id);
  if (!staff) throw new TRPCError({ code: 'FORBIDDEN' });
  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  return next({ ctx: { staff, mfaSatisfied: data?.currentLevel === 'aal2' } });
});

/**
 * Kestrel staff with a second factor (unless switched off for local development). This is the one
 * kind of procedure that is deliberately NOT limited to one organisation, so use it only under
 * /staff and record what staff read or change with recordStaffAudit.
 */
export const staffProcedure = staffIdentityProcedure.use(({ ctx, next }) => {
  if (mfaRequired() && !ctx.mfaSatisfied)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'MFA_REQUIRED' });
  return next();
});

export function requireStaffRole(staff: { roles: string[] }, needed: StaffRole) {
  if (!hasStaffRole(staff.roles, needed))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Insufficient staff role' });
}

/** For work that more than one staff role may do (for example notes: support or billing). */
export function requireAnyStaffRole(staff: { roles: string[] }, needed: StaffRole[]) {
  if (!needed.some((r) => hasStaffRole(staff.roles, r)))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Insufficient staff role' });
}
