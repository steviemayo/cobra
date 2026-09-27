import { db } from '@kestrel/db';
import { authenticateApiKey, makeRateLimiter } from './api-keys';
import { getEntitlements } from './billing';
import type { PublicApiDb } from './public-api';

const limiter = makeRateLimiter();

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
  const auth = await authenticateApiKey(db, req.headers.get('authorization'));
  if (!auth.ok) return json({ error: auth.error }, auth.status, { 'www-authenticate': 'Bearer' });
  const limit = limiter(auth.keyId);
  if (!limit.ok)
    return json({ error: 'Too many requests. Try again shortly.' }, 429, { 'retry-after': String(limit.retryAfterSeconds) });
  if (!(await getEntitlements(db, auth.orgId)).monitoring)
    return json({ error: 'The API is included with plans that have monitoring.' }, 402);
  const out = await handler({ orgId: auth.orgId, db });
  return out instanceof Response ? out : json(out.body, out.status ?? 200);
}
