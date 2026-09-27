import type { Metadata } from 'next';
import { SignupForm } from '@/components/auth/signup-form';
import { PROVIDER_NEXT, safeNext } from '@/lib/auth-redirect';

export const metadata: Metadata = { title: 'Create account' };

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; as?: string }>;
}) {
  const { next, as } = await searchParams;
  const provider = as === 'provider';
  const safe = safeNext(next);
  // A "sign up as a service provider" link carries the choice through email confirmation to the
  // set-up page, where it preselects the provider option. It never skips the choice itself.
  const after = safe === '/' && provider ? PROVIDER_NEXT : safe;
  return <SignupForm next={after} provider={provider} />;
}
