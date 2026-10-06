import { after } from 'next/server';
import { db } from '@kestrel/db';
import { queueAlerts } from '@/server/alert-batch';
import { readJson } from '@/server/gateway-http';
import { handleInbound } from '@/server/integrations/inbound';
import { clientIp, makeRateLimiter, tooManyRequests } from '@/server/rate-limit';

export const dynamic = 'force-dynamic';

const byAddress = makeRateLimiter(300, 60_000);
/** Webhook bodies are small. Anything bigger is not from the vendor. */
const MAX_BODY = 256 * 1024;

// A vendor tells Kestrel about a device or incident (Teams Rooms Pro Management, ...). The
// integration's secret is the credential, sent as Authorization: Bearer <secret> or x-kestrel-secret
// (a ?secret= query is accepted for services that can only set a URL); one leaked secret only ever
// reaches one integration.
export async function POST(req: Request, ctx: { params: Promise<{ integrationId: string }> }) {
  const limit = byAddress(clientIp(req));
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
  const { integrationId } = await ctx.params;
  const secret =
    /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ??
    req.headers.get('x-kestrel-secret') ??
    new URL(req.url).searchParams.get('secret') ??
    '';
  if (!/^[0-9a-f-]{36}$/i.test(integrationId) || !secret)
    return Response.json({ error: 'Unauthorised' }, { status: 401 });
  const body = await readJson(req, MAX_BODY);
  if (body === undefined) return Response.json({ error: 'That is not JSON' }, { status: 400 });
  const res = await handleInbound(db, { integrationId, secret, body });
  if (!res.ok) return Response.json({ error: res.message }, { status: res.status });
  if (res.jobs.length) after(() => queueAlerts(db, res.jobs));
  return Response.json({ ok: true, handled: res.handled, ignored: res.ignored });
}
