import type { Metadata } from 'next';
import { ForgotPasswordForm } from '@/components/auth/password-reset-forms';

export const metadata: Metadata = { title: 'Reset password' };

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
