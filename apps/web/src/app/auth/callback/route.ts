import { NextResponse, type NextRequest } from 'next/server';
import { safeNext } from '@/lib/auth-redirect';
import { createSupabaseServer } from '@/lib/supabase/server';

// Email confirmation and password-recovery links land here with a one-time code.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const next = safeNext(searchParams.get('next'));
  if (code) {
    const supabase = await createSupabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }
  return NextResponse.redirect(`${origin}/login?error=link`);
}
