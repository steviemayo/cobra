'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';

function Tile({
  label,
  value,
  of,
  bad,
}: {
  label: string;
  value: number;
  of?: number;
  bad?: boolean;
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          'text-2xl font-semibold tabular-nums',
          bad && value > 0 && 'text-destructive',
        )}
      >
        {value}
        {of !== undefined && (
          <span className="text-sm font-normal text-muted-foreground"> / {of}</span>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">
        {title} <span className="text-muted-foreground">({count})</span>
      </h2>
      {count === 0 ? (
        <p className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-success" /> Nothing to report
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">{children}</div>
      )}
    </section>
  );
}

const th = 'px-3 py-2 font-medium';
const td = 'px-3 py-2';

/** What is wrong across every customer right now: silent gateways, open incidents, releases that did not go live. */
export function StaffHealth() {
  const trpc = useTRPC();
  const health = useQuery({ ...trpc.staff.health.queryOptions(), refetchInterval: 30_000 });

  if (health.isPending)
    return (
      <PageContainer wide>
        <Skeleton className="h-64 w-full" />
      </PageContainer>
    );
  if (health.error || !health.data)
    return (
      <PageContainer wide>
        <p className="text-sm text-destructive">{health.error?.message ?? 'Not available'}</p>
      </PageContainer>
    );
  const h = health.data;
  const s = h.summary;
  const orgLink = (id: string, name: string) => (
    <Link href={`/staff/orgs/${id}`} className="hover:underline">
      {name}
    </Link>
  );

  return (
    <PageContainer wide>
      <PageHeader
        title="Fleet health"
        description="What needs attention across every customer. Refreshes every 30 seconds."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <Tile
          label="Organisations needing attention"
          value={s.organisationsNeedingAttention}
          of={s.organisations}
          bad
        />
        <Tile label="Gateways online" value={s.gatewaysOnline} of={s.gateways} />
        <Tile label="Gateways silent" value={s.gatewaysOffline} bad />
        <Tile label="Gateways behind" value={s.gatewaysBehind} />
        <Tile label="Open incidents" value={s.openIncidents} bad />
        <Tile label="Critical incidents" value={s.criticalIncidents} bad />
        <Tile label="Releases not live (7d)" value={s.failedDeployments} bad />
        <Tile label="Urgent tickets with us" value={s.urgentTickets} bad />
      </div>

      <Section title="Organisations needing attention" count={h.attention.length}>
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className={th}>Organisation</th>
              <th className={cn(th, 'text-right')}>Silent gateways</th>
              <th className={cn(th, 'text-right')}>Critical</th>
              <th className={cn(th, 'text-right')}>Open incidents</th>
              <th className={cn(th, 'text-right')}>Releases not live</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {h.attention.map((r) => (
              <tr key={r.orgId} className="hover:bg-muted/40">
                <td className={cn(td, 'font-medium')}>{orgLink(r.orgId, r.orgName)}</td>
                <td className={cn(td, 'text-right tabular-nums')}>{r.offlineGateways}</td>
                <td
                  className={cn(
                    td,
                    'text-right tabular-nums',
                    r.criticalIncidents > 0 && 'font-medium text-destructive',
                  )}
                >
                  {r.criticalIncidents}
                </td>
                <td className={cn(td, 'text-right tabular-nums')}>{r.openIncidents}</td>
                <td className={cn(td, 'text-right tabular-nums')}>{r.failedDeployments}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Silent gateways" count={h.offlineGateways.length}>
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className={th}>Gateway</th>
              <th className={th}>Organisation</th>
              <th className={th}>Site</th>
              <th className={cn(th, 'text-right')}>Rooms</th>
              <th className={th}>Version</th>
              <th className={th}>Last heard from</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {h.offlineGateways.map((g) => (
              <tr key={g.id} className="hover:bg-muted/40">
                <td className={cn(td, 'font-medium')}>{g.name}</td>
                <td className={td}>{orgLink(g.orgId, g.orgName)}</td>
                <td className={td}>{g.siteName}</td>
                <td className={cn(td, 'text-right tabular-nums')}>{g.rooms}</td>
                <td className={cn(td, 'text-muted-foreground')}>{g.version ?? 'unknown'}</td>
                <td className={cn(td, 'text-muted-foreground')}>
                  {g.lastSeenAt ? timeAgo(g.lastSeenAt) : 'never'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Open incidents" count={h.incidents.length}>
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className={th}>Incident</th>
              <th className={th}>Organisation</th>
              <th className={th}>Room</th>
              <th className={th}>Severity</th>
              <th className={th}>Open for</th>
              <th className={th}>Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {h.incidents.map((i) => (
              <tr key={i.id} className="hover:bg-muted/40">
                <td className={cn(td, 'font-medium')}>
                  {i.title}
                  {i.occurrences > 1 && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      ×{i.occurrences}
                    </span>
                  )}
                </td>
                <td className={td}>{orgLink(i.orgId, i.orgName)}</td>
                <td className={cn(td, 'text-muted-foreground')}>{i.roomName ?? 'Gateway'}</td>
                <td className={cn(td, i.severity === 'critical' && 'font-medium text-destructive')}>
                  {i.severity}
                </td>
                <td className={cn(td, 'text-muted-foreground')}>{timeAgo(i.openedAt)}</td>
                <td className={cn(td, 'text-muted-foreground')}>
                  {i.acknowledged ? 'Acknowledged' : 'Unacknowledged'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Releases that did not go live (7 days)" count={h.failedDeployments.length}>
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className={th}>Room</th>
              <th className={th}>Organisation</th>
              <th className={th}>What happened</th>
              <th className={th}>When</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {h.failedDeployments.map((d) => (
              <tr key={d.id} className="hover:bg-muted/40">
                <td className={cn(td, 'font-medium')}>{d.roomName}</td>
                <td className={td}>{orgLink(d.orgId, d.orgName)}</td>
                <td className={td}>
                  {d.status === 'rolled_back' ? 'Rolled back' : 'Failed'}
                  {d.error && <span className="text-muted-foreground">: {d.error}</span>}
                </td>
                <td className={cn(td, 'text-muted-foreground')}>{timeAgo(d.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Gateways behind the newest version" count={h.behindGateways.length}>
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className={th}>Gateway</th>
              <th className={th}>Organisation</th>
              <th className={th}>Channel</th>
              <th className={th}>Running</th>
              <th className={th}>Newest</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {h.behindGateways.map((g) => (
              <tr key={g.id} className="hover:bg-muted/40">
                <td className={cn(td, 'font-medium')}>{g.name}</td>
                <td className={td}>{orgLink(g.orgId, g.orgName)}</td>
                <td className={td}>{g.channel}</td>
                <td className={td}>{g.version ?? 'unknown'}</td>
                <td className={td}>{g.latest}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </PageContainer>
  );
}
