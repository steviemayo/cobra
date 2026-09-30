import { db } from '@kestrel/db';
import { handleEmailIn } from '@/server/itsm-service';
import { clientIp, makeRateLimiter, tooManyRequests } from '@/server/rate-limit';

export const dynamic = 'force-dynamic';

const byAddress = makeRateLimiter(30, 60_000);

// Mail forwarded by a mail service (any that can post parsed mail as JSON: { from, subject, text })
// becomes a ticket from that sender. The connector's secret is the credential.
export async function POST(req: Request, ctx: { params: Promise<{ connectorId: string }> }) {
  const limit = byAddress(clientIp(req));
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
  const { connectorId } = await ctx.params;
  const secret =
    /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ??
    req.headers.get('x-kestrel-secret') ??
    '';
  if (!/^[0-9a-f-]{36}$/i.test(connectorId) || !secret)
    return Response.json({ error: 'Unauthorised' }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'That is not JSON' }, { status: 400 });
  }
  const res = await handleEmailIn(db, { connectorId, secret, body });
  if (!res.ok)
    return Response.json(
      { error: res.message },
      { status: res.message === 'Not allowed' ? 401 : 400 },
    );
  return Response.json({ ok: true, ticketId: res.value.ticketId }, { status: 201 });
}
