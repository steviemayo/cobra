// Give someone access to the staff portal (or change their roles). The person must already have a
// Kestrel account (sign up normally first). Roles: admin, support, billing, readonly (admin covers all).
//
// Run from apps/web:
//   ../gateway/node_modules/.bin/tsx --env-file=../../.env scripts/add-staff.mts <email> <role[,role...]>
// Example:
//   ... scripts/add-staff.mts steven.mayo92@gmail.com admin
//
// Remove someone with:  ... scripts/add-staff.mts <email> none
import { createClient } from '@supabase/supabase-js';
import { db } from '@kestrel/db';
import { StaffRole } from '@kestrel/model';

const [email, rolesArg] = process.argv.slice(2);
if (!email || !rolesArg) {
  console.error('Usage: add-staff.mts <email> <admin|support|billing|readonly[,...]|none>');
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env).');
  process.exit(1);
}

const remove = rolesArg === 'none';
const roles = remove ? [] : rolesArg.split(',').map((r) => r.trim());
for (const r of roles)
  if (!StaffRole.safeParse(r).success) {
    console.error(`Unknown role "${r}". Use: ${StaffRole.options.join(', ')}`);
    process.exit(1);
  }

// Find the account by email. There is no lookup by email, so page through the users.
const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});
let userId: string | null = null;
for (let page = 1; !userId; page++) {
  const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
  if (error) {
    console.error('Could not list users:', error.message);
    process.exit(1);
  }
  userId = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())?.id ?? null;
  if (data.users.length < 200) break;
}
if (!userId) {
  console.error(`No Kestrel account with the email ${email}. Sign up first.`);
  process.exit(1);
}

if (remove) {
  await db.staffUser.deleteMany({ where: { userId } });
  await db.staffAudit.create({
    data: { staffUserId: userId, action: 'staff.remove', meta: { email } },
  });
  console.log(`${email} is no longer staff.`);
} else {
  await db.staffUser.upsert({
    where: { userId },
    create: { userId, email, roles },
    update: { email, roles },
  });
  await db.staffAudit.create({
    data: { staffUserId: userId, action: 'staff.set_roles', meta: { email, roles } },
  });
  console.log(`${email} is staff with roles: ${roles.join(', ')}.`);
}
await db.$disconnect();
