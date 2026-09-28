'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { DoorOpen, Plus, Rows3, Search } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { RoomsTable } from '@/components/common/rooms-table';
import { SimpleSelect } from '@/components/common/simple-select';
import { designHealth, type DesignHealth } from '@/components/common/status';
import type { HealthLevel } from '@/components/common/health';
import { useDialogs } from '@/components/shell/dialogs';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ROOM_TYPE_LABEL } from '@/lib/format';
import { useEstate } from '@/lib/use-estate';

const ALL = 'all';

export function RoomsView() {
  const { orgId, canEdit } = useOrg();
  const { openNewRoom } = useDialogs();
  const { sites, rooms, live, isPending } = useEstate();
  const [query, setQuery] = useState('');
  const [site, setSite] = useState(ALL);
  const [type, setType] = useState(ALL);
  const [design, setDesign] = useState<DesignHealth | typeof ALL>(ALL);
  const [status, setStatus] = useState<HealthLevel | typeof ALL>(ALL);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rooms.filter(
      (r) =>
        (!q || r.name.toLowerCase().includes(q) || r.site.name.toLowerCase().includes(q)) &&
        (site === ALL || r.siteId === site) &&
        (type === ALL || r.type === type) &&
        (design === ALL || designHealth(r.draft) === design) &&
        (status === ALL || live.get(r.id)?.health.level === status),
    );
  }, [rooms, query, site, type, design, status, live]);

  const filtering = query || site !== ALL || type !== ALL || design !== ALL || status !== ALL;

  return (
    <PageContainer>
      <PageHeader
        title="Rooms"
        description="Every room across all sites."
        actions={
          canEdit && (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                render={<Link href={orgPath(orgId, '/rooms/bulk')} />}
              >
                <Rows3 data-icon="inline-start" /> Create many
              </Button>
              <Button size="sm" onClick={() => openNewRoom()}>
                <Plus data-icon="inline-start" /> New room
              </Button>
            </div>
          )
        }
      />

      {isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : rooms.length === 0 ? (
        <EmptyState
          icon={DoorOpen}
          title="No rooms yet"
          description={
            sites.length
              ? 'Add your first room, pick a template and start designing.'
              : 'Create a site first, then add rooms to it.'
          }
          action={canEdit ? <Button onClick={() => openNewRoom()}>Add a room</Button> : undefined}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search rooms…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <SimpleSelect
              value={site}
              onValueChange={setSite}
              options={[
                { value: ALL, label: 'All sites' },
                ...sites.map((s) => ({ value: s.id, label: s.name })),
              ]}
            />
            <SimpleSelect
              value={type}
              onValueChange={setType}
              options={[
                { value: ALL, label: 'All types' },
                { value: 'meeting', label: ROOM_TYPE_LABEL.meeting },
                { value: 'training', label: ROOM_TYPE_LABEL.training },
              ]}
            />
            <SimpleSelect
              value={status}
              onValueChange={setStatus}
              options={[
                { value: ALL, label: 'Any live status' },
                { value: 'healthy', label: 'Healthy' },
                { value: 'degraded', label: 'Degraded' },
                { value: 'down', label: 'Down' },
                { value: 'unknown', label: 'Unknown' },
              ]}
            />
            <SimpleSelect
              value={design}
              onValueChange={setDesign}
              options={[
                { value: ALL, label: 'Any design status' },
                { value: 'ok', label: 'Design valid' },
                { value: 'warnings', label: 'Has warnings' },
                { value: 'errors', label: 'Has errors' },
                { value: 'none', label: 'No design yet' },
              ]}
            />
            {filtering && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQuery('');
                  setSite(ALL);
                  setType(ALL);
                  setDesign(ALL);
                  setStatus(ALL);
                }}
              >
                Clear
              </Button>
            )}
            <span className="tabular ml-auto text-xs text-muted-foreground">
              {filtered.length} of {rooms.length}
            </span>
          </div>
          {filtered.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No rooms match"
              description="Try a different search or filter."
            />
          ) : (
            <RoomsTable rooms={filtered} live={live} />
          )}
        </>
      )}
    </PageContainer>
  );
}
