import { notFound, redirect } from 'next/navigation';
import { db } from '@kestrel/db';
import { createSupabaseServer } from '@/lib/supabase/server';
import { findStaff } from '@/server/staff';

// Kestrel staff only. Anyone else, including signed-in customers, gets the same "not found" as any
// page that does not exist, so /staff does not advertise itself.
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect('/login?next=/staff');
  if (!(await findStaff(db, data.user.id))) notFound();
  return <div className="min-h-screen bg-background">{children}</div>;
}
