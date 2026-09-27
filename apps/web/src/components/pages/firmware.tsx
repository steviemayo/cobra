'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { CircuitBoard } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Skeleton } from '@/components/ui/skeleton';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';

/**
 * The firmware each device says it runs, across the estate. Read only: Kestrel reports what a
 * device tells it and never changes it. A device shows a version only if its driver can ask.
 */
export function FirmwareView() {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const report = useQuery({
    ...trpc.monitoring.firmware.queryOptions({ orgId }),
    refetchInterval: 30_000,
  });

  return (
    <PageContainer>
      <PageHeader
        title="Firmware"
        description="The firmware version each device reports. Kestrel only reads it: it never changes a device."
      />
      {report.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : report.error || !report.data ? (
        <p className="text-sm text-destructive">{report.error?.message ?? 'Not available'}</p>
      ) : report.data.rows.length === 0 ? (
        <EmptyState
          icon={CircuitBoard}
          title="No devices yet"
          description="Devices appear once the gateway running their room has reported in."
        />
      ) : (
        <>
          {report.data.drivers.every((d) => d.reporting === 0) && (
            <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
              No device has reported a firmware version yet. A version shows for a device whose
              driver can ask for it: PJLink class 2 projectors and displays, Biamp Tesira, and
              custom drivers that read one.
            </p>
          )}

          <section className="space-y-2">
            <h2 className="text-sm font-medium">By driver</h2>
            <ul className="divide-y overflow-hidden rounded-lg border text-sm">
              {report.data.drivers.map((g) => (
                <li
                  key={g.driver}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5"
                >
                  <span className="font-medium">{g.driver}</span>
                  <span className="text-muted-foreground">
                    {g.devices} {g.devices === 1 ? 'device' : 'devices'}
                    {g.reporting === 0
                      ? ', none report a version'
                      : g.reporting < g.devices
                        ? `, ${g.reporting} report a version`
                        : ''}
                    {g.versions.length > 0 && (
                      <>
                        {' · '}
                        {g.versions.map((v) => `${v.version} ×${v.count}`).join(', ')}
                      </>
                    )}
                    {g.mixed && (
                      <span className="ml-2 rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
                        Mixed versions
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">Every device</h2>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Device</th>
                    <th className="px-3 py-2 font-medium">Room</th>
                    <th className="px-3 py-2 font-medium">Driver</th>
                    <th className="px-3 py-2 font-medium">Firmware</th>
                    <th className="px-3 py-2 font-medium">Seen since</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.data.rows.map((r) => (
                    <tr key={`${r.roomId}:${r.deviceId}`} className="hover:bg-muted/40">
                      <td className="px-3 py-2 font-medium">{r.name}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        <Link
                          href={orgPath(orgId, `/rooms/${r.roomId}/monitoring`)}
                          className="hover:text-foreground hover:underline"
                        >
                          {r.roomName}
                        </Link>
                        {r.siteName && <span> · {r.siteName}</span>}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{r.driver ?? '—'}</td>
                      <td
                        className={cn(
                          'px-3 py-2 tabular-nums',
                          !r.firmware && 'text-muted-foreground',
                        )}
                      >
                        {r.firmware ?? 'Not reported'}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {r.firmwareSince ? timeAgo(r.firmwareSince) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </PageContainer>
  );
}
