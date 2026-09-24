import 'server-only';
import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { z } from 'zod';
import { db } from '@kestrel/db';
import type { OrgRole } from '@kestrel/model';
import { createSupabaseServer } from '@/lib/supabase/server';

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
export const orgProcedure = authedProcedure.use(async ({ ctx, next, getRawInput }) => {
  const parsed = orgInput.safeParse(await getRawInput());
  if (!parsed.success) throw new TRPCError({ code: 'BAD_REQUEST', message: 'orgId required' });
  const member = await db.member.findUnique({
    where: { orgId_userId: { orgId: parsed.data.orgId, userId: ctx.user.id } },
  });
  if (!member) throw new TRPCError({ code: 'FORBIDDEN' });
  return next({ ctx: { orgId: member.orgId, role: member.role as OrgRole } });
});

export function requireRole(role: OrgRole, allowed: OrgRole[]) {
  if (!allowed.includes(role))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Insufficient role' });
}
