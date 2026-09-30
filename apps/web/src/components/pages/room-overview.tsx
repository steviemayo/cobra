'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { HealthPill } from '@/components/common/health';
import { PageContainer } from '@/components/common/page-header';
import { Section } from '@/components/common/section';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { plural } from '@/lib/format';
import { useTRPC } from '@/trpc/client';
import { RoomDeviceList } from './room-devices';
import { useRoom } from './room-shell';

const NO_AREA = '__none';

/** Where the room sits: its area in the site, and free tags. */
function LocationPanel({ roomId, siteId }: { roomId: string; siteId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport } = useOrg();
  const { room } = useRoom(roomId);
  const areas = useQuery(trpc.area.list.queryOptions({ orgId, siteId }));
  const [tags, setTags] = useState<string | null>(null);
  const place = useMutation(
    trpc.area.placeRoom.mutationOptions({
      onSuccess: async () => {
        toast.success('Saved');
        setTags(null);
        await Promise.all([
          qc.invalidateQueries({ queryKey: trpc.room.overview.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.monitoring.estate.queryKey() }),
        ]);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (!room) return null;
  const options = [
    { value: NO_AREA, label: 'No area' },
    ...(areas.data ?? []).map((a) => ({
      value: a.id,
      label: `${a.label ? `${a.label}: ` : ''}${a.name}`,
    })),
  ];
  const currentTags = room.tags ?? [];
  const editing = tags !== null;
  return (
    <Section title="Location">
      <dl className="divide-y">
        <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
          <dt className="text-muted-foreground">Site</dt>
          <dd>
            <Link href={orgPath(orgId, `/sites/${siteId}`)} className="hover:underline">
              {room.site.name}
            </Link>
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
          <dt className="text-muted-foreground">Area</dt>
          <dd>
            {canSupport && (areas.data?.length ?? 0) > 0 ? (
              <SimpleSelect
                size="sm"
                className="w-48"
                value={room.areaId ?? NO_AREA}
                onValueChange={(v) =>
                  place.mutate({ orgId, roomId, areaId: v === NO_AREA ? null : v })
                }
                options={options}
              />
            ) : (
              <span>{options.find((o) => o.value === (room.areaId ?? NO_AREA))?.label}</span>
            )}
          </dd>
        </div>
        <div className="space-y-2 px-4 py-2.5 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">Tags</dt>
            {canSupport && !editing && (
              <Button size="xs" variant="ghost" onClick={() => setTags(currentTags.join(', '))}>
                Edit
              </Button>
            )}
          </div>
          <dd>
            {editing ? (
              <div className="flex gap-2">
                <Input
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="boardroom, VIP"
                  className="h-8"
                  aria-label="Tags, separated by commas"
                />
                <Button
                  size="sm"
                  disabled={place.isPending}
                  onClick={() =>
                    place.mutate({
                      orgId,
                      roomId,
                      tags: tags
                        .split(',')
                        .map((t) => t.trim())
                        .filter(Boolean),
                    })
                  }
                >
                  Save
                </Button>
              </div>
            ) : currentTags.length ? (
              <div className="flex flex-wrap gap-1.5">
                {currentTags.map((t) => (
                  <Badge key={t} variant="outline" className="font-normal">
                    {t}
                  </Badge>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </dd>
        </div>
      </dl>
    </Section>
  );
}

export function RoomOverview({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const { room } = useRoom(roomId);
  const estate = useQuery({
    ...trpc.monitoring.estate.queryOptions({ orgId }),
    staleTime: 15_000,
    refetchInterval: 15_000,
    retry: false,
  });
  if (!room) return null;
  const live = estate.data?.rooms.find((r) => r.id === roomId);

  return (
    <PageContainer className="pt-5">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Devices</h2>
            <Link
              href={orgPath(orgId, `/rooms/${roomId}/devices`)}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Full list <ArrowRight className="size-3" />
            </Link>
          </div>
          <RoomDeviceList roomId={roomId} compact />
        </div>

        <div className="space-y-6">
          <Section title="Status">
            {estate.isPending ? (
              <Skeleton className="m-4 h-12" />
            ) : !live ? (
              <p className="px-4 py-4 text-sm text-muted-foreground">
                Live status is not available.
              </p>
            ) : (
              <dl className="divide-y">
                <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
                  <dt className="text-muted-foreground">Live status</dt>
                  <dd>
                    <HealthPill level={live.health.level} reasons={live.health.reasons} />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
                  <dt className="text-muted-foreground">Monitored devices</dt>
                  <dd className="tabular">
                    {live.devices.active
                      ? `${live.devices.online} of ${live.devices.active} online`
                      : 'None'}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
                  <dt className="text-muted-foreground">Recorded assets</dt>
                  <dd className="tabular">{live.devices.passive}</dd>
                </div>
                <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
                  <dt className="text-muted-foreground">Open incidents</dt>
                  <dd>
                    <Link
                      href={orgPath(orgId, `/rooms/${roomId}/monitoring`)}
                      className="tabular hover:underline"
                    >
                      {plural(live.openIncidents, 'incident')}
                    </Link>
                  </dd>
                </div>
              </dl>
            )}
          </Section>

          <LocationPanel roomId={roomId} siteId={room.siteId} />
        </div>
      </div>
    </PageContainer>
  );
}
