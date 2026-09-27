'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  AlertTriangle,
  BellRing,
  Building2,
  ChevronRight,
  Cpu,
  KeyRound,
  Server,
  Link2,
  DoorOpen,
  LayoutDashboard,
  LayoutTemplate,
  LifeBuoy,
  type LucideIcon,
  Plus,
  Rocket,
  Router,
  Settings,
  Store,
  Users,
  Handshake,
} from 'lucide-react';
import { AnimatedCollapse } from '@/components/common/animated-collapse';
import { StatusDot, roomHealth } from '@/components/common/status';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { useEstate } from '@/lib/use-estate';
import { cn } from '@/lib/utils';
import { useDialogs } from './dialogs';
import { OrgSwitcher } from './org-switcher';
import { orgPath, useOrg } from './org-context';
import { UserMenu } from './user-menu';

function useActive() {
  const pathname = usePathname();
  return (href: string, exact = false) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

function NavItem({
  href,
  icon: Icon,
  label,
  exact,
  soon,
}: {
  href?: string;
  icon: LucideIcon;
  label: string;
  exact?: boolean;
  soon?: boolean;
}) {
  const isActive = useActive();
  if (soon || !href)
    return (
      <SidebarMenuItem>
        <SidebarMenuButton disabled aria-disabled tooltip={`${label} — coming soon`}>
          <Icon />
          <span>{label}</span>
        </SidebarMenuButton>
        <SidebarMenuBadge className="text-[10px] uppercase tracking-wide">Soon</SidebarMenuBadge>
      </SidebarMenuItem>
    );
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isActive(href, exact)}
        tooltip={label}
        render={<Link href={href} />}
      >
        <Icon />
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function EstateTree() {
  const { orgId } = useOrg();
  const pathname = usePathname();
  const { sites, rooms, roomsBySite, isPending } = useEstate();
  const [manual, setManual] = useState<Record<string, boolean>>({});

  const activeSiteId = (() => {
    const site = pathname.match(/\/sites\/([0-9a-f-]{36})/)?.[1];
    if (site) return site;
    const room = pathname.match(/\/rooms\/([0-9a-f-]{36})/)?.[1];
    return rooms.find((r) => r.id === room)?.siteId;
  })();

  if (isPending)
    return (
      <div className="space-y-2 px-2 py-1">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-4/5" />
      </div>
    );

  if (sites.length === 0)
    return <p className="px-2 py-1 text-xs text-muted-foreground">No sites yet.</p>;

  return (
    <SidebarMenu>
      {sites.map((site) => {
        const siteRooms = roomsBySite.get(site.id) ?? [];
        const open = manual[site.id] ?? (site.id === activeSiteId || sites.length <= 2);
        const sitePath = orgPath(orgId, `/sites/${site.id}`);
        return (
          <SidebarMenuItem key={site.id}>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                aria-label={open ? `Collapse ${site.name}` : `Expand ${site.name}`}
                aria-expanded={open}
                onClick={() => setManual((m) => ({ ...m, [site.id]: !open }))}
                className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              >
                <ChevronRight
                  className={cn('size-3.5 transition-transform duration-200', open && 'rotate-90')}
                />
              </button>
              <SidebarMenuButton
                size="sm"
                className="flex-1"
                isActive={pathname === sitePath}
                render={<Link href={sitePath} />}
              >
                <Building2 />
                <span>{site.name}</span>
              </SidebarMenuButton>
            </div>
            <AnimatedCollapse open={open}>
              <SidebarMenuSub>
                {siteRooms.length === 0 && (
                  <li className="px-2 py-1 text-xs text-muted-foreground">No rooms</li>
                )}
                {siteRooms.map((r) => {
                  const href = orgPath(orgId, `/rooms/${r.id}`);
                  return (
                    <SidebarMenuSubItem key={r.id}>
                      <SidebarMenuSubButton
                        isActive={pathname === href || pathname.startsWith(`${href}/`)}
                        render={<Link href={href} />}
                      >
                        <StatusDot health={roomHealth(r.draft)} />
                        <span>{r.name}</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  );
                })}
              </SidebarMenuSub>
            </AnimatedCollapse>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

/**
 * A service provider's name and logo at the top of the sidebar, when this portal wears their brand.
 * Kestrel stays credited, quietly.
 */
function BrandMark() {
  const { brand } = useOrg();
  if (!brand) return null;
  return (
    <div className="flex items-center gap-2 px-2 pt-1 group-data-[collapsible=icon]:hidden">
      {brand.logoUrl && (
        // Any https image the provider chose, so a plain img rather than next/image.
        <img src={brand.logoUrl} alt="" className="h-7 max-w-24 object-contain" />
      )}
      <div className="grid min-w-0 leading-tight">
        <span className="truncate text-sm font-semibold">{brand.name}</span>
        <span className="text-[10px] text-muted-foreground">Powered by Kestrel</span>
      </div>
    </div>
  );
}

export function AppSidebar() {
  const { orgId, org, canEdit, canSeeTeam, canSupport, isOwner } = useOrg();
  // A service provider has customers rather than an estate of its own.
  const isMsp = org.kind === 'msp';
  // A provider limited to some sites only gets the site-aware areas.
  const scoped = !!org.scoped;
  const { openNewSite } = useDialogs();
  const base = orgPath(orgId);
  const isActive = useActive();
  const settingsOpen = isActive(`${base}/settings`);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <BrandMark />
        <OrgSwitcher />
      </SidebarHeader>

      <SidebarContent>
        {isMsp ? (
          <SidebarGroup>
            <SidebarGroupLabel>Service provider</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <NavItem href={`${base}/msp`} icon={Handshake} label="Customers" exact />
                <NavItem href={`${base}/msp/tickets`} icon={LifeBuoy} label="Support queue" />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {scoped ? (
                  <NavItem href={`${base}/rooms`} icon={DoorOpen} label="Rooms" exact />
                ) : (
                  <NavItem href={base} icon={LayoutDashboard} label="Overview" exact />
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {!isMsp && (
          <>
            <SidebarGroup className="group-data-[collapsible=icon]:hidden">
              <SidebarGroupLabel>Estate</SidebarGroupLabel>
              {canEdit && (
                <SidebarGroupAction title="New site" onClick={openNewSite}>
                  <Plus />
                  <span className="sr-only">New site</span>
                </SidebarGroupAction>
              )}
              <SidebarGroupContent>
                <EstateTree />
              </SidebarGroupContent>
            </SidebarGroup>

            <SidebarGroup>
              <SidebarGroupLabel>Manage</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {canSupport && <NavItem href={`${base}/sites`} icon={Building2} label="Sites" />}
                  <NavItem href={`${base}/rooms`} icon={DoorOpen} label="Rooms" />
                  {canEdit && !scoped && (
                    <NavItem href={`${base}/templates`} icon={LayoutTemplate} label="Templates" />
                  )}
                  {canEdit && !scoped && (
                    <NavItem href={`${base}/marketplace`} icon={Store} label="Marketplace" />
                  )}
                  {canEdit && !scoped && (
                    <NavItem href={`${base}/drivers`} icon={Cpu} label="Custom drivers" />
                  )}
                  {canEdit && !scoped && (
                    <NavItem href={`${base}/credentials`} icon={KeyRound} label="Shared logins" />
                  )}
                  {canEdit && !scoped && (
                    <NavItem href={`${base}/shared-devices`} icon={Server} label="Shared devices" />
                  )}
                  {canSupport && (
                    <NavItem href={`${base}/gateways`} icon={Router} label="Gateways" />
                  )}
                  {canSupport && !scoped && (
                    <NavItem href={`${base}/deployments`} icon={Rocket} label="Deployments" />
                  )}
                  {canSupport && !scoped && (
                    <NavItem href={`${base}/groups`} icon={Link2} label="Room groups" />
                  )}
                  <NavItem href={`${base}/monitoring`} icon={Activity} label="Monitoring" />
                  {canSupport && (
                    <NavItem href={`${base}/incidents`} icon={AlertTriangle} label="Incidents" />
                  )}
                  <NavItem href={`${base}/tickets`} icon={LifeBuoy} label="Support" />
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </>
        )}

        {canSeeTeam && !scoped && (
          <SidebarGroup>
            <SidebarGroupLabel>Organisation</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <NavItem href={`${base}/team`} icon={Users} label="Team" />
                <NavItem href={`${base}/alerts`} icon={BellRing} label="Alerts" />
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={settingsOpen}
                    tooltip="Settings"
                    render={<Link href={`${base}/settings`} />}
                  >
                    <Settings />
                    <span>Settings</span>
                  </SidebarMenuButton>
                  <AnimatedCollapse open={settingsOpen}>
                    <SidebarMenuSub>
                      {isOwner && (
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton
                            isActive={isActive(`${base}/settings`, true)}
                            render={<Link href={`${base}/settings`} />}
                          >
                            <span>General</span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      )}
                      {isOwner && (
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton
                            isActive={isActive(`${base}/settings/billing`)}
                            render={<Link href={`${base}/settings/billing`} />}
                          >
                            <span>Plan and billing</span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      )}
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton
                          isActive={isActive(`${base}/settings/activity`)}
                          render={<Link href={`${base}/settings/activity`} />}
                        >
                          <span>Activity log</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    </SidebarMenuSub>
                  </AnimatedCollapse>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <UserMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
