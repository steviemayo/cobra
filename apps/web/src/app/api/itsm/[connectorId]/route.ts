import { db } from '@kestrel/db';
import { handleInbound } from '@/server/itsm-service';
import { clientIp, makeRateLimiter, tooManyRequests } from '@/server/rate-limit';

export const dynamic = 'force-dynamic';

const byAddress = makeRateLimiter(120, 60_000);

// A service desk tells Kestrel about a ticket: its status changed, someone commented, or it now has
// a reference on the other side. The connector's secret is the credential (Authorization: Bearer
// <secret>, or x-kestrel-secret); one leaked secret only ever reaches one connector.
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
  const res = await handleInbound(db, { connectorId, secret, body });
  if (!res.ok)
    return Response.json(
      { error: res.message },
      { status: res.message === 'Not allowed' ? 401 : 400 },
    );
  return Response.json({ ok: true, ticketId: res.value.ticketId });
}
