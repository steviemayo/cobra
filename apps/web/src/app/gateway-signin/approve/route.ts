import { NextResponse } from 'next/server';
import { db } from '@kestrel/db';
import { createSupabaseServer } from '@/lib/supabase/server';
import { issueGrant } from '@/server/gateway-signin';
import { loadSigningKey } from '@/server/signing';

export const dynamic = 'force-dynamic';

// The person confirmed on /gateway-signin. Everything is checked again here (the form's fields are
// only a request), then the browser is sent to the gateway with a short-lived signed grant.
export async function POST(req: Request) {
  const here = new URL(req.url);
  // A form posted from another site must not be able to approve a sign-in.
  const origin = req.headers.get('origin');
  if (origin && new URL(origin).origin !== here.origin)
    return new NextResponse('Not allowed', { status: 403 });

  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) return NextResponse.redirect(new URL('/login', here), 303);

  const form = await req.formData();
  const text = (k: string) => (typeof form.get(k) === 'string' ? (form.get(k) as string) : '');

  let signing;
  try {
    signing = loadSigningKey();
  } catch {
    return new NextResponse('Signing in to gateways is not set up on this server yet.', { status: 503 });
  }
  const meta = user.user_metadata as { full_name?: string; name?: string } | undefined;
  const result = await issueGrant(
    db,
    signing,
    { id: user.id, email: user.email ?? null, name: meta?.full_name ?? meta?.name ?? null },
    { gatewayId: text('gateway'), state: text('state'), returnOrigin: text('return') },
  );
  if (!result.ok) {
    const back = new URL('/gateway-signin', here);
    for (const [k, v] of [['gateway', text('gateway')], ['state', text('state')], ['return', text('return')]])
      back.searchParams.set(k!, v!);
    return NextResponse.redirect(back, 303);
  }
  const res = NextResponse.redirect(result.url, 303);
  // The link carries a grant: it must not be cached or leak through a Referer header.
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}
