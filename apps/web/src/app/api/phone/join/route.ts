import { z } from 'zod';
import { db } from '@kestrel/db';
import { joinRoom } from '@/server/phone-control';

export const dynamic = 'force-dynamic';

// Public on purpose: the signed link from the room's QR code is the credential.
export async function POST(req: Request) {
  const body = z.object({ token: z.string().max(200) }).safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: 'Bad request' }, { status: 400 });
  const res = await joinRoom(db, { joinToken: body.data.token }, process.env.KESTREL_SECRETS_KEY);
  return res.ok ? Response.json(res.value) : Response.json({ error: res.error }, { status: res.status });
}
