import { db } from '@kestrel/db';
import { announce } from '@/server/gateway-announce';
import { clientIp, makeRateLimiter, tooManyRequests } from '@/server/rate-limit';

export const dynamic = 'force-dynamic';

const MAX_BODY = 4096;
// Separate from the daily new-install cap in gateway-announce.ts (which only counts installs this
// address has never been seen from before): this bounds plain request volume, including repeated
// wrong-secret guesses against an install id that already exists.
const byAddress = makeRateLimiter(20, 60_000);

// A gateway that is running but cannot enrol says who it is here, so staff can see it and give it
// to the right organisation. No credential (it has none yet): what it may do is bounded and it gets
// nothing back but its status. See docs/decisions.md, Step S.
export async function POST(req: Request) {
  const ip = clientIp(req);
  const limit = byAddress(ip);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > MAX_BODY) return Response.json({ error: 'Too large' }, { status: 400 });
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = undefined;
  }
  const r = await announce(db, raw, {
    ip: ip === 'unknown' ? null : ip,
    key: process.env.KESTREL_SECRETS_KEY || undefined,
  });
  return Response.json(r.body, { status: r.status });
}
