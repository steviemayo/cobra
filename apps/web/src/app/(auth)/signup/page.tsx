import type { Metadata } from 'next';
import { SignupForm } from '@/components/auth/signup-form';
import { safeNext } from '@/lib/auth-redirect';

export const metadata: Metadata = { title: 'Create account' };

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return <SignupForm next={safeNext(next)} />;
}
