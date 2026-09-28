// A shared way to slow down abuse of the routes nobody has to sign in to reach (gateway enrolment
// and announce, invite previews, webhook hooks, phone links, the public API's own credential
// check) and a few authenticated ones a person could otherwise hammer (making organisations, join
// requests). One counter per server process: on a host that runs several copies each counts on
// its own, so the real limit can be a few times higher than the number below. That is enough to
// stop a script that is guessing or flooding; it is not a substitute for a shared store, which is
// tracked as a later improvement (M3).

export type RateLimitVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

export function makeRateLimiter(limit: number, windowMs: number) {
  const seen = new Map<string, { start: number; count: number }>();
  return (key: string, now = Date.now()): RateLimitVerdict => {
    if (seen.size > 5000)
      for (const [k, v] of seen) if (now - v.start >= windowMs) seen.delete(k);
    const cur = seen.get(key);
    if (!cur || now - cur.start >= windowMs) {
      seen.set(key, { start: now, count: 1 });
      return { ok: true };
    }
    cur.count++;
    return cur.count > limit
      ? { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((cur.start + windowMs - now) / 1000)) }
      : { ok: true };
  };
}

/**
 * The caller's address, for rate limiting only (never for access control: it is only as trustworthy
 * as the platform's proxy, which on Vercel sets it correctly but a self-hosted reverse proxy might
 * not). Behind the platform's proxy the caller's address is the first hop it reports.
 */
export function clientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

/** The standard shape for a Route Handler to answer with when a limit is hit. */
export function tooManyRequests(retryAfterSeconds: number): Response {
  return Response.json(
    { error: 'Too many requests. Try again shortly.' },
    { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } },
  );
}
