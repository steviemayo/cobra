'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Building2, Check, DoorOpen, Plus } from 'lucide-react';
import { ActivityFeed } from '@/components/common/activity-feed';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader, Stagger, StaggerItem } from '@/components/common/page-header';
import { RoomsTable } from '@/components/common/rooms-table';
import { HEALTH_ORDER, HealthPill } from '@/components/common/health';
import { DesignBadge, designHealth } from '@/components/common/status';
import { useDialogs } from '@/components/shell/dialogs';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { plural } from '@/lib/format';
import { useEstate } from '@/lib/use-estate';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tabular mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function GettingStarted({
  hasSite,
  hasRoom,
  hasDesign,
}: {
  hasSite: boolean;
  hasRoom: boolean;
  hasDesign: boolean;
}) {
  const { orgId, canEdit } = useOrg();
  const { openNewSite, openNewRoom } = useDialogs();
  const steps = [
    {
      done: hasSite,
      title: 'Create a site',
      body: 'A building or campus that holds your rooms.',
      action:
        canEdit && !hasSite ? (
          <Button size="sm" onClick={openNewSite}>
            Create site
          </Button>
        ) : null,
    },
    {
      done: hasRoom,
      title: 'Add a room',
      body: 'Pick a room type; you’ll choose a starting template next.',
      action:
        canEdit && hasSite && !hasRoom ? (
          <Button size="sm" onClick={() => openNewRoom()}>
            Add room
          </Button>
        ) : null,
    },
    {
      done: hasDesign,
      title: 'Design the room',
      body: 'Model devices and connections. Kestrel checks the design as you go.',
      action: null,
    },
    {
      done: false,
      title: 'Connect a gateway',
      body: 'Deploy to an on-site gateway. Available in a later release.',
      action: null,
      soon: true,
    },
  ];
  const next = steps.findIndex((s) => !s.done);
  return (
    <section className="rounded-lg border">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-medium">Get started</h2>
        <p className="text-xs text-muted-foreground">
          {steps.filter((s) => s.done).length} of {steps.length - 1} steps done
        </p>
      </div>
      <ol className="divide-y">
        {steps.map((s, i) => (
          <li
            key={s.title}
            className={cn('flex items-center gap-3 px-4 py-3', s.soon && 'opacity-60')}
          >
            <span
              className={cn(
                'grid size-5 shrink-0 place-items-center rounded-full border text-[10px]',
                s.done && 'border-success bg-success text-background',
                !s.done && i === next && 'border-brand text-brand',
              )}
            >
              {s.done ? <Check className="size-3" /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div
                className={cn(
                  'text-sm font-medium',
                  s.done && 'text-muted-foreground line-through',
                )}
              >
                {s.title}
              </div>
              <div className="text-xs text-muted-foreground">{s.body}</div>
            </div>
            {s.action}
            {i === 2 && hasRoom && !hasDesign && (
              <Link href={orgPath(orgId, '/rooms')} className={buttonVariants({ size: 'sm' })}>
                Open rooms
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function OverviewView() {
  const trpc = useTRPC();
  const { org, orgId, canEdit, canSeeTeam } = useOrg();
  const { openNewSite, openNewRoom } = useDialogs();
  const { sites, rooms, roomsBySite, live, isPending } = useEstate();
  const activity = useQuery({
    ...trpc.audit.list.queryOptions({ orgId, limit: 8 }),
    enabled: canSeeTeam,
    retry: false,
  });

  // Live problems first: this is "what's actually broken right now", not a lint pass over designs.
  const liveIssues = rooms
    .filter((r) => {
      const level = live.get(r.id)?.health.level;
      return level === 'degraded' || level === 'down';
    })
    .sort(
      (a, b) =>
        HEALTH_ORDER[live.get(a.id)!.health.level] - HEALTH_ORDER[live.get(b.id)!.health.level],
    );
  const designIssues = rooms.filter((r) => !r.monitorOnly && designHealth(r.draft) !== 'ok');
  const hasDesign = rooms.some((r) => r.draft);
  const onboarding = !isPending && (!sites.length || !rooms.length || !hasDesign);

  return (
    <PageContainer>
      <PageHeader
        title="Overview"
        description={`Everything across ${org.name}.`}
        actions={
          canEdit && (
            <>
              <Button variant="outline" size="sm" onClick={openNewSite}>
                <Building2 data-icon="inline-start" /> New site
              </Button>
              <Button size="sm" onClick={() => openNewRoom()}>
                <Plus data-icon="inline-start" /> New room
              </Button>
            </>
          )
        }
      />

      {isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <Stagger className="space-y-6">
          <StaggerItem>
            <div className="grid grid-cols-2 divide-x divide-y overflow-hidden rounded-lg border sm:grid-cols-4 sm:divide-y-0">
              <Stat label="Sites" value={sites.length} />
              <Stat label="Rooms" value={rooms.length} />
              <Stat
                label="Live issues"
                value={liveIssues.length}
                hint={
                  liveIssues.length ? 'Degraded or down right now' : 'Everything reporting is fine'
                }
              />
              <Stat
                label="Needs design work"
                value={designIssues.length}
                hint={
                  designIssues.length ? 'Errors, warnings or no design yet' : 'All designs valid'
                }
              />
            </div>
          </StaggerItem>

          {onboarding && (
            <StaggerItem>
              <GettingStarted
                hasSite={sites.length > 0}
                hasRoom={rooms.length > 0}
                hasDesign={hasDesign}
              />
            </StaggerItem>
          )}

          <StaggerItem className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="min-w-0 space-y-6">
              <Section
                title="Estate"
                action={
                  <Link
                    href={orgPath(orgId, '/rooms')}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    All rooms <ArrowRight className="size-3" />
                  </Link>
                }
              >
                {sites.length === 0 ? (
                  <EmptyState
                    icon={Building2}
                    title="No sites yet"
                    description="Sites hold your rooms. Create one to get started."
                    action={
                      canEdit ? <Button onClick={openNewSite}>Create a site</Button> : undefined
                    }
                  />
                ) : (
                  <div className="space-y-4">
                    {sites.map((site) => {
                      const siteRooms = roomsBySite.get(site.id) ?? [];
                      return (
                        <div key={site.id} className="space-y-2">
                          <div className="flex items-center justify-between">
                            <Link
                              href={orgPath(orgId, `/sites/${site.id}`)}
                              className="inline-flex items-center gap-2 text-sm font-medium hover:underline"
                            >
                              <Building2 className="size-4 text-muted-foreground" />
                              {site.name}
                              <span className="font-normal text-muted-foreground">
                                {plural(siteRooms.length, 'room')}
                              </span>
                            </Link>
                            {canEdit && (
                              <Button
                                variant="ghost"
                                size="xs"
                                onClick={() => openNewRoom(site.id)}
                              >
                                <Plus data-icon="inline-start" /> Room
                              </Button>
                            )}
                          </div>
                          {siteRooms.length === 0 ? (
                            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                              No rooms in this site yet.
                            </p>
                          ) : (
                            <RoomsTable rooms={siteRooms} live={live} showSite={false} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </Section>
            </div>

            <div className="space-y-6">
              <Section title="Live issues">
                {liveIssues.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing is degraded or down right now.
                  </p>
                ) : (
                  <ul className="divide-y rounded-lg border">
                    {liveIssues.slice(0, 6).map((r) => (
                      <li key={r.id}>
                        <Link
                          href={orgPath(orgId, `/rooms/${r.id}/monitoring`)}
                          className="flex items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-muted/50"
                        >
                          <DoorOpen className="size-4 text-muted-foreground" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{r.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {r.site.name}
                            </span>
                          </span>
                          <HealthPill
                            level={live.get(r.id)!.health.level}
                            reasons={live.get(r.id)!.health.reasons}
                          />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {designIssues.length > 0 && (
                <Section title="Needs design work">
                  <ul className="divide-y rounded-lg border">
                    {designIssues.slice(0, 6).map((r) => (
                      <li key={r.id}>
                        <Link
                          href={orgPath(orgId, `/rooms/${r.id}`)}
                          className="flex items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-muted/50"
                        >
                          <DoorOpen className="size-4 text-muted-foreground" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{r.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {r.site.name}
                            </span>
                          </span>
                          <DesignBadge draft={r.draft} monitorOnly={r.monitorOnly} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {canSeeTeam && (
                <Section
                  title="Recent activity"
                  action={
                    <Link
                      href={orgPath(orgId, '/settings/activity')}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      View all
                    </Link>
                  }
                >
                  {activity.isPending ? (
                    <Skeleton className="h-24 w-full" />
                  ) : (
                    <ActivityFeed rows={activity.data ?? []} />
                  )}
                </Section>
              )}
            </div>
          </StaggerItem>
        </Stagger>
      )}
    </PageContainer>
  );
}
