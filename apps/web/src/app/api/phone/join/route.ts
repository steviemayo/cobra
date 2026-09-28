import { z } from 'zod';
import { db } from '@kestrel/db';
import { joinRoom } from '@/server/phone-control';
import { clientIp, makeRateLimiter, tooManyRequests } from '@/server/rate-limit';

export const dynamic = 'force-dynamic';

// Join tokens are signed and short-lived, so guessing one is infeasible; this only keeps a script
// from hammering the database with attempts.
const byAddress = makeRateLimiter(20, 60_000);

// Public on purpose: the signed link from the room's QR code is the credential.
export async function POST(req: Request) {
  const limit = byAddress(clientIp(req));
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
  const body = z.object({ token: z.string().max(200) }).safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: 'Bad request' }, { status: 400 });
  const res = await joinRoom(db, { joinToken: body.data.token }, process.env.KESTREL_SECRETS_KEY);
  return res.ok ? Response.json(res.value) : Response.json({ error: res.error }, { status: res.status });
}
