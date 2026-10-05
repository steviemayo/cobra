'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Building2,
  Cable,
  FileText,
  LifeBuoy,
  Router,
  ScrollText,
  Users,
  Wrench,
} from 'lucide-react';
import { hasStaffRole, type StaffRole } from '@kestrel/model';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';

const NAV: { href: string; label: string; icon: typeof Building2; needs?: StaffRole[] }[] = [
  { href: '/staff/orgs', label: 'Organisations', icon: Building2 },
  { href: '/staff/health', label: 'Fleet health', icon: Activity },
  { href: '/staff/gateways', label: 'Unclaimed gateways', icon: Router },
  { href: '/staff/invoices', label: 'Invoice requests', icon: FileText, needs: ['billing'] },
  { href: '/staff/tickets', label: 'Tickets', icon: LifeBuoy },
  { href: '/staff/driver-requests', label: 'Driver requests', icon: Cable },
  { href: '/staff/callouts', label: 'Callouts', icon: Wrench },
  { href: '/staff/audit', label: 'Audit trail', icon: ScrollText, needs: ['admin', 'support'] },
  { href: '/staff/team', label: 'Team', icon: Users, needs: ['admin'] },
];

// The staff portal frame: deliberately plain and unlike the customer portal, so nobody mistakes
// which one they are in.
export function StaffShell({
  email,
  roles,
  children,
}: {
  email: string;
  roles: string[];
  children: React.ReactNode;
}) {
  const path = usePathname();
  const trpc = useTRPC();
  // How many gateways are waiting to be claimed, so a new one is noticed without opening the page.
  const unclaimed = useQuery({
    ...trpc.staff.gateways.unclaimed.queryOptions(),
    refetchInterval: 60_000,
    retry: false,
  });
  const waiting = (unclaimed.data ?? []).filter((g) => g.status === 'open').length;
  const canBill = hasStaffRole(roles, 'billing');
  const invoices = useQuery({
    ...trpc.staff.invoiceRequests.list.queryOptions(),
    refetchInterval: 60_000,
    retry: false,
    enabled: canBill,
  });
  const invoiceWaiting = invoices.data?.length ?? 0;
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b bg-muted/40 px-4 py-2 sm:px-6">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="rounded bg-primary px-1.5 py-0.5 text-xs text-primary-foreground">
            STAFF
          </span>
          Kestrel
        </div>
        <nav aria-label="Staff" className="flex gap-1">
          {NAV.filter(({ needs }) => !needs || needs.some((r) => hasStaffRole(roles, r))).map(
            ({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                aria-current={path.startsWith(href) ? 'page' : undefined}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground',
                  path.startsWith(href) && 'bg-muted font-medium text-foreground',
                )}
              >
                <Icon className="size-4" /> {label}
                {href === '/staff/gateways' && waiting > 0 && (
                  <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                    {waiting}
                  </span>
                )}
                {href === '/staff/invoices' && invoiceWaiting > 0 && (
                  <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                    {invoiceWaiting}
                  </span>
                )}
              </Link>
            ),
          )}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            {email} · {roles.join(', ')}
          </span>
          <Link href="/" className="underline-offset-2 hover:underline">
            Customer portal
          </Link>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
