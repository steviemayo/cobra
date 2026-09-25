// Where the staff portal may be served from. With STAFF_HOST unset (the default) /staff is served
// on the normal host. Setting STAFF_HOST to e.g. "admin.example.com" moves it: /staff is then
// refused on every other host, and that host serves nothing but the staff portal and the sign-in
// and API routes it needs. The pages do not change.
export type StaffHostVerdict = 'ok' | 'not-found' | 'to-staff';

const ALWAYS = ['/staff', '/login', '/auth/', '/api/', '/forgot-password', '/reset-password'];

export function staffHostVerdict(
  host: string | null,
  pathname: string,
  staffHost: string | undefined = process.env.STAFF_HOST,
): StaffHostVerdict {
  if (!staffHost) return 'ok';
  const here = (host ?? '').toLowerCase().split(':')[0];
  const isStaffHost = here === staffHost.toLowerCase();
  const isStaffPath = pathname === '/staff' || pathname.startsWith('/staff/');
  if (isStaffPath && !isStaffHost) return 'not-found';
  if (isStaffHost && !ALWAYS.some((p) => pathname === p || pathname.startsWith(p)))
    return 'to-staff';
  return 'ok';
}
