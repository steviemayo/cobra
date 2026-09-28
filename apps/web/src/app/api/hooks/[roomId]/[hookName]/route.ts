import { db } from '@kestrel/db';
import { secretMatches } from '@kestrel/crypto';
import { getEntitlements } from '@/server/billing';
import { queueHook } from '@/server/control-service';
import { clientIp, makeRateLimiter, tooManyRequests } from '@/server/rate-limit';

export const dynamic = 'force-dynamic';

const unauthorised = () => Response.json({ error: 'Unauthorised' }, { status: 401 });
// Bounds how many database reads a wrong secret or an unknown room id can cost, before the room's
// own per-minute cap on queued hooks (control-service.ts) even comes into play.
const byAddress = makeRateLimiter(60, 60_000);

// An outside system (a booking tool, a building controller) asks a room to run a webhook trigger.
// The room's own secret is the credential, so one leaked secret only ever reaches one room.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ roomId: string; hookName: string }> },
) {
  const limit = byAddress(clientIp(req));
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
  const { roomId, hookName } = await ctx.params;
  const given =
    /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ??
    req.headers.get('x-kestrel-secret') ??
    '';
  if (!/^[0-9a-f-]{36}$/i.test(roomId) || !given) return unauthorised();
  const room = await db.room.findFirst({
    where: { id: roomId },
    select: { id: true, orgId: true, hookSecretHash: true },
  });
  // Unknown rooms and wrong secrets look the same.
  if (!room?.hookSecretHash || !secretMatches(given, room.hookSecretHash)) return unauthorised();
  // A webhook runs a room's actions, so it needs control. The gateway refuses it as well.
  if (!(await getEntitlements(db, room.orgId)).control)
    return Response.json({ error: 'Control is not included in this organisation’s plan.' }, { status: 402 });
  const res = await queueHook(db, { orgId: room.orgId, roomId: room.id, hookName });
  if (!res.ok)
    return Response.json(
      { error: res.error },
      { status: res.error.startsWith('Too many') ? 429 : 400 },
    );
  return Response.json({ queued: true }, { status: 202 });
}
