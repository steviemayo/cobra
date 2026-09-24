import { redirect } from 'next/navigation';
import { createSupabaseServer } from '@/lib/supabase/server';

export default async function Home() {
  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getUser();
  redirect(data.user ? '/dashboard' : '/login');
}
