'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { LicencePanel } from '@/components/staff/licence-panel';
import { NotesPanel } from '@/components/staff/notes-panel';
import { SessionPanel } from '@/components/staff/session-panel';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate, timeAgo } from '@/lib/format';
import { useTRPC } from '@/trpc/client';

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-medium tabular-nums">{value}</div>
    </div>
  );
}

/** One organisation as staff see it. Opening this page is written to the staff audit trail. */
export function StaffOrg({ orgId }: { orgId: string }) {
  const trpc = useTRPC();
  const org = useQuery(trpc.staff.orgs.get.queryOptions({ orgId }));

  if (org.isPending)
    return (
      <PageContainer>
        <Skeleton className="h-64 w-full" />
      </PageContainer>
    );
  if (org.error || !org.data)
    return (
      <PageContainer>
        <p className="text-sm text-destructive">{org.error?.message ?? 'Not found'}</p>
      </PageContainer>
    );
  const o = org.data;

  return (
    <PageContainer>
      <PageHeader
        title={o.name}
        description={`Created ${formatDate(o.createdAt)}`}
        actions={
          <Link
            href="/staff/orgs"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> All organisations
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Plan"
          value={
            o.plan === 'trial' && o.trialDaysLeft !== null
              ? `Trial, ${o.trialDaysLeft < 0 ? 'ended' : `${o.trialDaysLeft}d left`}`
              : o.plan
          }
        />
        <Stat label="Rooms (billed)" value={o.rooms} />
        <Stat label="Combined rooms" value={o.combinedRooms} />
        <Stat label="Gateways online" value={`${o.gatewaysOnline}/${o.gateways}`} />
        <Stat label="Open incidents" value={o.openIncidents} />
        <Stat label="Open tickets" value={o.openTickets} />
        <Stat label="People" value={o.members} />
        <Stat label="Last activity" value={o.lastActivity ? timeAgo(o.lastActivity) : 'Never'} />
      </div>

      <SessionPanel orgId={orgId} blocked={o.staffAccessBlocked} />

      <LicencePanel orgId={orgId} />

      <NotesPanel orgId={orgId} />

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-2">
          <h2 className="text-sm font-medium">Sites</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {o.sites.length === 0 && <li className="px-3 py-2 text-muted-foreground">None</li>}
            {o.sites.map((s) => (
              <li key={s.id} className="flex justify-between px-3 py-2">
                <span>{s.name}</span>
                <span className="text-muted-foreground">
                  {s.rooms} {s.rooms === 1 ? 'room' : 'rooms'}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-medium">People</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {o.team.map((t) => (
              <li key={t.userId} className="flex justify-between px-3 py-2">
                <span>{t.email ?? 'No email'}</span>
                <span className="text-muted-foreground">{t.role.replace('_', ' ')}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-medium">Recent activity in the organisation</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {o.recentActivity.length === 0 && (
              <li className="px-3 py-2 text-muted-foreground">None</li>
            )}
            {o.recentActivity.map((a) => (
              <li key={a.id} className="flex justify-between gap-3 px-3 py-2">
                <span className="truncate">{a.action}</span>
                <span className="shrink-0 text-muted-foreground">{timeAgo(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-medium">Staff who looked at this organisation</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {o.staffActivity.map((a) => (
              <li key={a.id} className="flex justify-between gap-3 px-3 py-2">
                <span>{a.action}</span>
                <span className="text-muted-foreground">{timeAgo(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </PageContainer>
  );
}
