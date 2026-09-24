import { z } from 'zod';
import { db } from '@kestrel/db';
import { phoneIntent } from '@/server/phone-control';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = z
    .object({ session: z.string().max(200), intent: z.unknown() })
    .safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: 'Bad request' }, { status: 400 });
  const res = await phoneIntent(db, body.data, process.env.KESTREL_SECRETS_KEY);
  return res.ok ? Response.json(res.value) : Response.json({ error: res.error }, { status: res.status });
}
