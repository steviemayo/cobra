'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { validateRoomModel } from '@kestrel/engine';
import { useMemo } from 'react';
import { ArrowRight, Rocket } from 'lucide-react';
import { PageContainer } from '@/components/common/page-header';
import { GatewayStatus, HealthBadge } from '@/components/common/status';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import { useRoom } from './room-shell';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2.5">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function RoomOverview({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const { room } = useRoom(roomId);
  const draft = useQuery({
    ...trpc.draft.get.queryOptions({ orgId, roomId }),
    staleTime: 0,
  });
  const versions = useQuery(trpc.draft.versions.queryOptions({ orgId, roomId }));
  const issues = useMemo(
    () => (draft.data ? validateRoomModel(draft.data.model).issues : []),
    [draft.data],
  );
  if (!room) return null;
  const designHref = orgPath(orgId, `/rooms/${roomId}/design`);

  return (
    <PageContainer className="pt-5">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <Panel
            title="Design"
            action={
              <Link
                href={designHref}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                Open designer <ArrowRight className="size-3" />
              </Link>
            }
          >
            {draft.isPending ? (
              <Skeleton className="m-4 h-24" />
            ) : !room.draft ? (
              <div className="space-y-3 px-4 py-6">
                <p className="text-sm text-muted-foreground">
                  This room hasn’t been designed yet. Start from a template, then add devices and
                  connections.
                </p>
                <Link href={designHref} className={buttonVariants({ size: 'sm' })}>
                  Start designing
                </Link>
              </div>
            ) : (
              <dl className="divide-y">
                <Row label="Status">
                  <HealthBadge draft={room.draft} />
                </Row>
                <Row label="Devices">
                  <span className="tabular">{room.draft.devices}</span>
                </Row>
                <Row label="Activities">
                  <span className="tabular">{room.draft.activities}</span>
                </Row>
                <Row label="Revision">
                  <span className="tabular">{room.draft.revision}</span>
                </Row>
                <Row label="Last edited">{timeAgo(room.draft.updatedAt)}</Row>
              </dl>
            )}
          </Panel>

          {issues.length > 0 && (
            <Panel title={`Design checks (${issues.length})`}>
              <ul className="divide-y">
                {issues.slice(0, 8).map((i, n) => (
                  <li key={n} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                    <span
                      aria-hidden
                      className={cn(
                        'mt-1.5 size-2 shrink-0 rounded-full',
                        i.severity === 'error' ? 'bg-destructive' : 'bg-warning',
                      )}
                    />
                    {i.message}
                  </li>
                ))}
              </ul>
              {issues.length > 8 && (
                <div className="border-t px-4 py-2.5 text-xs text-muted-foreground">
                  and {issues.length - 8} more in the designer.
                </div>
              )}
            </Panel>
          )}
        </div>

        <div className="space-y-6">
          <Panel title="Deployment">
            <div className="space-y-3 px-4 py-4 text-sm">
              <div className="flex items-center gap-2">
                <Rocket className="size-4 text-muted-foreground" />
                <span className="font-medium">Not deployed</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Releases and deployments arrive in a later release. Designs are saved as drafts
                until then.
              </p>
              <dl className="divide-y rounded-md border">
                <Row label="Gateway">
                  <GatewayStatus gateway={room.gateway} />
                </Row>
              </dl>
            </div>
          </Panel>

          <Panel title="Saved versions">
            {versions.isPending ? (
              <Skeleton className="m-4 h-12" />
            ) : versions.data?.length ? (
              <ul className="divide-y">
                {versions.data.slice(0, 5).map((v) => (
                  <li
                    key={v.id}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                  >
                    <span className="min-w-0 truncate">{v.label || 'Untitled version'}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {timeAgo(v.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-4 text-xs text-muted-foreground">
                No versions saved. Use “Save version” in the designer to create a restore point.
              </p>
            )}
          </Panel>
        </div>
      </div>
    </PageContainer>
  );
}
