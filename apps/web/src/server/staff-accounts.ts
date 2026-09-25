import 'server-only';
import { createSupabaseAdmin } from '@/lib/supabase/admin';
import type { AccountLookup } from './staff-team';

const PER_PAGE = 200;
const MAX_PAGES = 50;

/**
 * Looks up Kestrel accounts by email through the Supabase admin API, which has no lookup by email,
 * so it pages through the users (up to 10,000).
 */
export function supabaseAccounts(): AccountLookup {
  return {
    async findByEmail(email) {
      const supabase = createSupabaseAdmin();
      for (let page = 1; page <= MAX_PAGES; page++) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: PER_PAGE });
        if (error) throw new Error('Could not look up accounts right now. Try again.');
        const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
        if (hit) return { id: hit.id, email: hit.email! };
        if (data.users.length < PER_PAGE) return null;
      }
      return null;
    },
  };
}
