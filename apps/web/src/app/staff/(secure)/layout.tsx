import { redirect } from 'next/navigation';
import { db } from '@kestrel/db';
import { StaffShell } from '@/components/staff/staff-shell';
import { createSupabaseServer } from '@/lib/supabase/server';
import { findStaff, mfaRequired } from '@/server/staff';

// Everything in the staff portal except the second-factor page itself needs a verified second factor.
export default async function SecureStaffLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createSupabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  const staff = auth.user ? await findStaff(db, auth.user.id) : null;
  if (!staff) redirect('/login?next=/staff');

  if (mfaRequired()) {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (data?.currentLevel !== 'aal2') redirect('/staff/mfa');
  }
  return (
    <StaffShell email={staff.email ?? auth.user?.email ?? ''} roles={staff.roles}>
      {children}
    </StaffShell>
  );
}
