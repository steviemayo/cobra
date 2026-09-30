import type { Metadata } from 'next';
import { RegisterIssuesView } from '@/components/pages/register-issues';

export const metadata: Metadata = { title: 'Register issues' };

export default function Page() {
  return <RegisterIssuesView />;
}
