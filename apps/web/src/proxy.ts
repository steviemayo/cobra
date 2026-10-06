import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { staffHostVerdict } from '@/lib/staff-host';

const PUBLIC_PREFIXES = [
  '/login',
  '/signup',
  '/forgot-password',
  '/auth/',
  '/invite/',
  '/c/',
  '/verify',
  '/why-kestrel',
  '/terms',
  '/privacy',
];
const GUEST_ONLY = ['/login', '/signup', '/forgot-password'];

export async function proxy(request: NextRequest) {
  // The staff portal can be pinned to its own host (STAFF_HOST). See lib/staff-host.ts.
  const verdict = staffHostVerdict(request.headers.get('host'), request.nextUrl.pathname);
  if (verdict === 'not-found') return new NextResponse(null, { status: 404 });
  if (verdict === 'to-staff') {
    const url = request.nextUrl.clone();
    url.pathname = '/staff';
    url.search = '';
    return NextResponse.redirect(url);
  }
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (items) => {
          items.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          items.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );
  const { data } = await supabase.auth.getUser();
  const { pathname, search } = request.nextUrl;

  // API routes enforce auth themselves (tRPC procedures), so leave them alone.
  if (pathname.startsWith('/api/')) return response;

  const isPublic = PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
  if (!data.user && !isPublic && pathname !== '/') {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  if (data.user && GUEST_ONLY.includes(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico)$).*)'],
};
