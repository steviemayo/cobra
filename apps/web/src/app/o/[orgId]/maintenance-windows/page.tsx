import type { Metadata } from 'next';
import { MaintenanceWindowsView } from '@/components/pages/maintenance-windows';

export const metadata: Metadata = { title: 'Maintenance windows' };

export default function Page() {
  return <MaintenanceWindowsView />;
}
