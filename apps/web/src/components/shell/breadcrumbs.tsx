'use client';
import { Fragment } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { useEstate } from '@/lib/use-estate';
import { orgPath, useOrg } from './org-context';

interface Crumb {
  label: string;
  href?: string;
}

const SECTION_LABEL: Record<string, string> = {
  sites: 'Sites',
  rooms: 'Rooms',
  templates: 'Templates',
  gateways: 'Gateways',
  deployments: 'Deployments',
  team: 'Team',
  settings: 'Settings',
};

const ROOM_TAB_LABEL: Record<string, string> = {
  design: 'Design',
  simulate: 'Simulate',
  devices: 'Devices',
  deployments: 'Deployments',
  settings: 'Settings',
};

// Org / section / site / room / tab, resolved from cached estate data so names show immediately.
export function Breadcrumbs() {
  const pathname = usePathname();
  const { orgId, org } = useOrg();
  const { sites, rooms } = useEstate();
  const base = orgPath(orgId);
  const [section, id, tab] = pathname.slice(base.length).split('/').filter(Boolean);

  const crumbs: Crumb[] = [{ label: org.name, href: section ? base : undefined }];
  if (section) {
    crumbs.push({
      label: SECTION_LABEL[section] ?? section,
      href: id || tab ? `${base}/${section}` : undefined,
    });
  }
  if (section === 'sites' && id) {
    const site = sites.find((s) => s.id === id);
    crumbs.push({ label: site?.name ?? 'Site', href: tab ? `${base}/sites/${id}` : undefined });
    if (tab) crumbs.push({ label: tab.charAt(0).toUpperCase() + tab.slice(1) });
  }
  if (section === 'rooms' && id) {
    const room = rooms.find((r) => r.id === id);
    if (room)
      crumbs.splice(
        1,
        1,
        { label: 'Sites', href: `${base}/sites` },
        { label: room.site.name, href: `${base}/sites/${room.siteId}` },
      );
    crumbs.push({ label: room?.name ?? 'Room', href: tab ? `${base}/rooms/${id}` : undefined });
    if (tab) crumbs.push({ label: ROOM_TAB_LABEL[tab] ?? tab });
  }
  if (section === 'settings' && id) crumbs.push({ label: id === 'activity' ? 'Activity log' : id });

  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <Fragment key={`${i}-${c.label}`}>
              {i > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem className="min-w-0">
                {last || !c.href ? (
                  <BreadcrumbPage className="truncate">{c.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink render={<Link href={c.href} />} className="truncate">
                    {c.label}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
