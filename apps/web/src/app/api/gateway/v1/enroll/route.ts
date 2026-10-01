import { db } from '@kestrel/db';
import { readJson, respond } from '@/server/gateway-http';
import { enroll } from '@/server/gateway-service';
import { clientIp, makeRateLimiter, tooManyRequests } from '@/server/rate-limit';
import { trustedPublicKeys } from '@/server/signing';

export const dynamic = 'force-dynamic';

// Tokens are 24 random bytes, so guessing one is infeasible either way; this only keeps a script
// from hammering the database with attempts.
const byAddress = makeRateLimiter(20, 60_000);

export async function POST(req: Request) {
  const limit = byAddress(clientIp(req));
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
  return respond(await enroll(db, await readJson(req), trustedPublicKeys()));
}
