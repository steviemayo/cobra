'use client';
import { useOrg } from '@/components/shell/org-context';
import { CustomerDashboard } from './customer-dashboard';
import { OverviewView } from './overview';

/** Builders and support get the overview; customers get their rooms, control and help. */
export function HomeView() {
  const { role } = useOrg();
  return role === 'customer_viewer' ? <CustomerDashboard /> : <OverviewView />;
}
