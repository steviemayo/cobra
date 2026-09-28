import { db } from '@kestrel/db';
import { announce } from '@/server/gateway-announce';

export const dynamic = 'force-dynamic';

const MAX_BODY = 4096;

// A gateway that is running but cannot enrol says who it is here, so staff can see it and give it
// to the right organisation. No credential (it has none yet): what it may do is bounded and it gets
// nothing back but its status. See docs/decisions.md, Step S.
export async function POST(req: Request) {
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > MAX_BODY) return Response.json({ error: 'Too large' }, { status: 400 });
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = undefined;
  }
  // Behind the platform's proxy the caller's address is the first hop it reports.
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    null;
  const r = await announce(db, raw, { ip, key: process.env.KESTREL_SECRETS_KEY || undefined });
  return Response.json(r.body, { status: r.status });
}
