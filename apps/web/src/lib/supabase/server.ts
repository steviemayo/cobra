import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { requireEnv } from '@/lib/env';

export async function createSupabaseServer() {
  const store = await cookies();
  return createServerClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (items) => {
          try {
            items.forEach(({ name, value, options }) => store.set(name, value, options));
          } catch {
            // called from a Server Component; proxy refreshes the session
          }
        },
      },
    },
  );
}
