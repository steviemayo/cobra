'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Building2, Plus } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useDialogs } from '@/components/shell/dialogs';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { formatDate } from '@/lib/format';
import { useSites } from '@/lib/use-estate';

export function SitesView() {
  const router = useRouter();
  const { orgId, canEdit } = useOrg();
  const { openNewSite } = useDialogs();
  const sites = useSites();

  return (
    <PageContainer>
      <PageHeader
        title="Sites"
        description="Physical locations that contain your rooms."
        actions={
          canEdit && (
            <Button size="sm" onClick={openNewSite}>
              <Plus data-icon="inline-start" /> New site
            </Button>
          )
        }
      />
      {sites.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : sites.data?.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No sites yet"
          description="Create a site for each building or campus, then add rooms to it."
          action={canEdit ? <Button onClick={openNewSite}>Create a site</Button> : undefined}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Site</TableHead>
                <TableHead>Timezone</TableHead>
                <TableHead className="text-right">Rooms</TableHead>
                <TableHead className="text-right">Gateways</TableHead>
                <TableHead className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sites.data?.map((s) => {
                const href = orgPath(orgId, `/sites/${s.id}`);
                return (
                  <TableRow key={s.id} className="cursor-pointer" onClick={() => router.push(href)}>
                    <TableCell className="font-medium">
                      <Link
                        href={href}
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-2 hover:underline"
                      >
                        <Building2 className="size-4 text-muted-foreground" />
                        {s.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.timezone.replace(/_/g, ' ')}
                    </TableCell>
                    <TableCell className="tabular text-right">{s._count.rooms}</TableCell>
                    <TableCell className="tabular text-right">{s._count.gateways}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {formatDate(s.createdAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </PageContainer>
  );
}
