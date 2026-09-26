import type { Metadata } from 'next';
import { CredentialsView } from '@/components/pages/credentials';

export const metadata: Metadata = { title: 'Shared logins' };

export default function CredentialsPage() {
  return <CredentialsView />;
}
