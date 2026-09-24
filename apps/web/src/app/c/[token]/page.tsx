import type { Metadata } from 'next';
import { PhoneControl } from '@/components/pages/phone-control';

export const metadata: Metadata = { title: 'Room control', robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PhoneControl token={token} />;
}
