import { redirect } from 'next/navigation';
import { createSupabaseServer } from '@/lib/supabase/server';

// Kestrel staff pages. The page itself checks the admin list; this only makes sure someone is signed in.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect('/login?next=/admin/marketplace');
  return <div className="min-h-screen">{children}</div>;
}
