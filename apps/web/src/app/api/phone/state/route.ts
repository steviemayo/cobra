import { z } from 'zod';
import { db } from '@kestrel/db';
import { phoneState } from '@/server/phone-control';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = z.object({ session: z.string().max(200) }).safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: 'Bad request' }, { status: 400 });
  const res = await phoneState(db, body.data.session, process.env.KESTREL_SECRETS_KEY);
  return res.ok ? Response.json(res.value) : Response.json({ error: res.error }, { status: res.status });
}
