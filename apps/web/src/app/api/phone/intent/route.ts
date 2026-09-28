import { z } from 'zod';
import { db } from '@kestrel/db';
import { phoneIntent } from '@/server/phone-control';
import { clientIp, makeRateLimiter, tooManyRequests } from '@/server/rate-limit';

export const dynamic = 'force-dynamic';

// Generous: a real session can send several intents a second while someone holds a volume button.
const byAddress = makeRateLimiter(180, 60_000);

export async function POST(req: Request) {
  const limit = byAddress(clientIp(req));
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
  const body = z
    .object({ session: z.string().max(200), intent: z.unknown() })
    .safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: 'Bad request' }, { status: 400 });
  const res = await phoneIntent(db, body.data, process.env.KESTREL_SECRETS_KEY);
  return res.ok ? Response.json(res.value) : Response.json({ error: res.error }, { status: res.status });
}
