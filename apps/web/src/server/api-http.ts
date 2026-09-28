import { db } from '@kestrel/db';
import { REQUESTS_PER_MINUTE, authenticateApiKey } from './api-keys';
import { getEntitlements } from './billing';
import type { PublicApiDb } from './public-api';
import { clientIp, makeRateLimiter, tooManyRequests } from './rate-limit';

const byKey = makeRateLimiter(REQUESTS_PER_MINUTE, 60_000);
/** Before a key is even checked, so a script guessing at keys cannot hammer the database. */
const byAddress = makeRateLimiter(60, 60_000);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

/**
 * Runs a public API handler for the organisation that owns the key on the request. Answers 401 for
 * a bad key, 429 past the rate limit, and 402 when the organisation's plan does not include the API
 * (it comes with monitoring). Errors are JSON: { "error": "..." }.
 */
export async function withApiKey(
  req: Request,
  handler: (ctx: { orgId: string; db: PublicApiDb }) => Promise<Response | { status?: number; body: unknown }>,
): Promise<Response> {
  const early = byAddress(clientIp(req));
  if (!early.ok) return tooManyRequests(early.retryAfterSeconds);
  const auth = await authenticateApiKey(db, req.headers.get('authorization'));
  if (!auth.ok) return json({ error: auth.error }, auth.status, { 'www-authenticate': 'Bearer' });
  const limit = byKey(auth.keyId);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
  if (!(await getEntitlements(db, auth.orgId)).monitoring)
    return json({ error: 'The API is included with plans that have monitoring.' }, 402);
  const out = await handler({ orgId: auth.orgId, db });
  return out instanceof Response ? out : json(out.body, out.status ?? 200);
}
