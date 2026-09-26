import type { Metadata } from 'next';
import { BulkRoomsView } from '@/components/pages/bulk-rooms';

export const metadata: Metadata = { title: 'Create rooms from a template' };

export default function BulkRoomsPage() {
  return <BulkRoomsView />;
}
