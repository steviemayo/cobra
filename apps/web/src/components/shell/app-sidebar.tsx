'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  AlertTriangle,
  CalendarCheck,
  CalendarOff,
  ClipboardCheck,
  FileCheck2,
  GitCompare,
  History,
  ListChecks,
  Package,
  Plug,
  Sigma,
  SlidersHorizontal,
  BellRing,
  Building2,
  CircuitBoard,
  ChevronRight,
  Layers,
  Cpu,
  KeyRound,
  DoorOpen,
  LayoutDashboard,
  LifeBuoy,
  Lock,
  type LucideIcon,
  Plus,
  Router,
  Settings,
  Users,
  Handshake,
  BarChart3,
  FileText,
  Wrench,
} from 'lucide-react';
import { AnimatedCollapse } from '@/components/common/animated-collapse';
import { useBilling } from '@/components/common/plan-gate';
import { HealthDot } from '@/components/common/health';
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
  useSidebar,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { useEstate, useEstateOverview } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';
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
  count,
  locked,
}: {
  href?: string;
  icon: LucideIcon;
  label: string;
  exact?: boolean;
  soon?: boolean;
  /** A number to show beside the label (something waiting), when above zero. */
  count?: number;
  /** Not in the plan: still listed, with a lock. The page it opens says what to do. */
  locked?: boolean;
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
        tooltip={locked ? `${label} — not in your plan` : label}
        render={<Link href={href} />}
      >
        <Icon />
        <span>{label}</span>
      </SidebarMenuButton>
      {locked && (
        <SidebarMenuBadge aria-label="Not in your plan">
          <Lock className="size-3" />
        </SidebarMenuBadge>
      )}
      {!locked && !!count && (
        <SidebarMenuBadge aria-label={`${count} waiting`}>{count}</SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}

function EstateTree() {
  const { orgId } = useOrg();
  const pathname = usePathname();
  const { sites, rooms, roomsBySite, isPending } = useEstate();
  const estate = useEstateOverview();
  const health = new Map((estate.data?.rooms ?? []).map((r) => [r.id, r.health]));
  const areas = estate.data?.areas ?? [];
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

  // Rooms with no area first, then each area (and the areas inside it) with its rooms.
  const renderTree = (siteRooms: typeof rooms, siteAreas: typeof areas) => {
    const room = (r: (typeof rooms)[number], depth: number) => {
      const href = orgPath(orgId, `/rooms/${r.id}`);
      const h = health.get(r.id);
      return (
        <SidebarMenuSubItem key={r.id} style={{ paddingLeft: depth * 10 }}>
          <SidebarMenuSubButton
            isActive={pathname === href || pathname.startsWith(`${href}/`)}
            render={<Link href={href} />}
          >
            <HealthDot level={h?.level ?? 'unknown'} />
            <span title={h?.reasons[0]}>{r.name}</span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      );
    };
    const area = (a: (typeof areas)[number], depth: number): React.ReactNode => (
      <li key={a.id} className="list-none">
        <div
          className="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
          style={{ paddingLeft: 8 + depth * 10 }}
          title={a.label ?? undefined}
        >
          <Layers className="size-3" />
          <span className="truncate">{a.name}</span>
        </div>
        <ul className="m-0 list-none p-0">
          {siteRooms.filter((r) => r.areaId === a.id).map((r) => room(r, depth + 1))}
          {siteAreas.filter((c) => c.parentId === a.id).map((c) => area(c, depth + 1))}
        </ul>
      </li>
    );
    const inArea = new Set(siteAreas.map((a) => a.id));
    return (
      <>
        {siteRooms.filter((r) => !r.areaId || !inArea.has(r.areaId)).map((r) => room(r, 0))}
        {siteAreas.filter((a) => !a.parentId || !inArea.has(a.parentId)).map((a) => area(a, 0))}
      </>
    );
  };

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
                {renderTree(
                  siteRooms,
                  areas.filter((a) => a.siteId === site.id),
                )}
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

interface NavEntry {
  href: string;
  icon: LucideIcon;
  label: string;
  exact?: boolean;
  count?: number;
  locked?: boolean;
  /** A v2 page not built yet: listed disabled with a Soon badge. */
  soon?: boolean;
}

/**
 * A collapsible group of links. The group holding the current page opens when you arrive, the
 * choice to open or close one is remembered in this browser, and while the sidebar is collapsed to
 * icons every group shows its icons.
 */
function NavGroup({
  id,
  label,
  defaultOpen = false,
  items,
  action,
  children,
}: {
  id: string;
  label: string;
  defaultOpen?: boolean;
  items: NavEntry[];
  /** A small button beside the heading, kept visible when the group is closed. */
  action?: React.ReactNode;
  /** Extra content above the links (the estate tree). */
  children?: React.ReactNode;
}) {
  const isActive = useActive();
  const { state, isMobile } = useSidebar();
  const [manual, setManual] = useState<boolean | null>(null);
  const holdsPage = items.some((i) => isActive(i.href, i.exact));

  useEffect(() => {
    try {
      const saved = localStorage.getItem(`kestrel.nav.${id}`);
      if (saved === 'open' || saved === 'closed') setManual(saved === 'open');
    } catch {
      // Storage can be blocked; the group just uses its default.
    }
  }, [id]);
  // Arriving at a page inside a group you had closed opens it again.
  useEffect(() => {
    if (holdsPage) setManual((m) => (m === false ? true : m));
  }, [holdsPage]);

  if (items.length === 0 && !children) return null;
  const iconsOnly = state === 'collapsed' && !isMobile;
  const open = iconsOnly || (manual ?? (defaultOpen || holdsPage));
  const toggle = () => {
    setManual(!open);
    try {
      localStorage.setItem(`kestrel.nav.${id}`, open ? 'closed' : 'open');
    } catch {
      // Not remembered, which is fine.
    }
  };

  return (
    <SidebarGroup>
      <SidebarGroupLabel
        render={<button type="button" onClick={toggle} aria-expanded={open} />}
        className="cursor-pointer justify-between hover:text-sidebar-foreground"
      >
        {label}
        <ChevronRight
          className={cn('size-3.5 transition-transform duration-200', open && 'rotate-90')}
        />
      </SidebarGroupLabel>
      {action}
      <AnimatedCollapse open={open}>
        <SidebarGroupContent>
          {children}
          {items.length > 0 && (
            <SidebarMenu>
              {items.map((i) => (
                <NavItem key={i.href} {...i} />
              ))}
            </SidebarMenu>
          )}
        </SidebarGroupContent>
      </AnimatedCollapse>
    </SidebarGroup>
  );
}

export function AppSidebar() {
  const { orgId, org, canEdit, canSeeTeam, canSupport, isOwner } = useOrg();
  // A service provider has customers rather than an estate of its own.
  const isMsp = org.kind === 'msp';
  // A provider limited to some sites only gets the site-aware areas.
  const scoped = !!org.scoped;
  const { openNewSite } = useDialogs();
  const trpc = useTRPC();
  // What the plan includes. Until it loads nothing is locked, so the menu does not flash.
  const plan = useBilling().data?.entitlements;
  const drivers = plan?.driverCreate ?? true;
  // What each plan includes, so the pages it does not are still listed, with a lock.
  const has = {
    configuration: plan?.configuration ?? true,
    maintenance: plan?.maintenance ?? true,
    registerIssues: plan?.registerIssues ?? true,
    serviceDesk: plan?.serviceDesk ?? true,
    usageDefinitions: plan?.usageDefinitions ?? true,
  };
  // People from the company asking to join, waiting for an owner.
  const joinRequests = useQuery({
    ...trpc.joinRequest.count.queryOptions({ orgId }),
    enabled: isOwner && !scoped,
    refetchInterval: 60_000,
  });
  const base = orgPath(orgId);
  const isActive = useActive();
  const settingsOpen = isActive(`${base}/settings`);

  const entries = (list: (NavEntry | false)[]) => list.filter((e): e is NavEntry => !!e);
  const full = !scoped;

  const estateLinks = entries([
    canSupport && { href: `${base}/sites`, icon: Building2, label: 'All sites' },
    { href: `${base}/rooms`, icon: DoorOpen, label: 'All rooms' },
  ]);
  // v2 pivot (PV-13, step M0). Routes for Templates, Marketplace, Room groups, Deployments and
  // Shared devices still exist until the staged removal but are no longer linked from here.
  // Items with `soon` are the new v2 pages, built in later steps (docs/pivot-monitoring.md).
  const monitor = entries([
    { href: `${base}/monitoring`, icon: Activity, label: 'Monitoring' },
    canSupport && { href: `${base}/incidents`, icon: AlertTriangle, label: 'Incidents' },
    canSeeTeam && full && { href: `${base}/alerts`, icon: BellRing, label: 'Alerts' },
    canSupport && { href: `${base}/gateways`, icon: Router, label: 'Gateways' },
    canEdit &&
      full && {
        href: `${base}/maintenance-windows`,
        icon: CalendarOff,
        label: 'Maintenance windows',
      },
  ]);
  const assets = entries([
    canSupport && { href: `${base}/assets`, icon: Package, label: 'Register' },
    canEdit &&
      full && {
        href: `${base}/register-issues`,
        icon: FileCheck2,
        label: 'Register issues',
        locked: !has.registerIssues,
      },
    canEdit && full && { href: `${base}/credentials`, icon: KeyRound, label: 'Shared logins' },
    canSupport && { href: `${base}/firmware`, icon: CircuitBoard, label: 'Firmware' },
    canEdit &&
      full && { href: `${base}/drivers`, icon: Cpu, label: 'Custom drivers', locked: !drivers },
  ]);
  const maintenance = entries([
    canSupport && {
      href: `${base}/pm/schedule`,
      icon: CalendarCheck,
      label: 'Schedule',
      locked: !has.maintenance,
    },
    canSupport && {
      href: `${base}/pm/records`,
      icon: ClipboardCheck,
      label: 'PM records',
      locked: !has.maintenance,
    },
    canEdit &&
      full && {
        href: `${base}/pm/templates`,
        icon: ListChecks,
        label: 'PM templates',
        locked: !has.maintenance,
      },
  ]);
  const configuration = entries([
    canSupport && {
      href: `${base}/config/profiles`,
      icon: SlidersHorizontal,
      label: 'Profiles',
      locked: !has.configuration,
    },
    canSupport && {
      href: `${base}/config/drift`,
      icon: GitCompare,
      label: 'Snapshots and drift',
      locked: !has.configuration,
    },
    canSupport && {
      href: `${base}/config/changes`,
      icon: History,
      label: 'Changes',
      locked: !has.configuration,
    },
  ]);
  const analytics = entries([
    { href: `${base}/usage`, icon: BarChart3, label: 'Usage' },
    canEdit &&
      full && {
        href: `${base}/room-definitions`,
        icon: Sigma,
        label: 'Room definitions',
        locked: !has.usageDefinitions,
      },
    full && { href: `${base}/reports`, icon: FileText, label: 'Reports' },
  ]);
  const support = entries([
    { href: `${base}/tickets`, icon: LifeBuoy, label: 'Tickets' },
    { href: `${base}/callouts`, icon: Wrench, label: 'Callouts' },
    canEdit &&
      full && {
        href: `${base}/integrations`,
        icon: Plug,
        label: 'Integrations',
        locked: !has.serviceDesk,
      },
  ]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <BrandMark />
        <OrgSwitcher />
      </SidebarHeader>

      <SidebarContent>
        {/* A service provider looks after customers and also has an estate of its own (its Internal estate). */}
        {isMsp && (
          <SidebarGroup>
            <SidebarGroupLabel>Customers</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <NavItem href={`${base}/msp`} icon={Handshake} label="Portfolio" exact />
                <NavItem
                  href={`${base}/msp/incidents`}
                  icon={AlertTriangle}
                  label="All incidents"
                />
                <NavItem href={`${base}/msp/tickets`} icon={LifeBuoy} label="Support queue" />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        {
          <>
            {full && (
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <NavItem
                      href={base}
                      icon={LayoutDashboard}
                      label={isMsp ? 'Internal estate' : 'Overview'}
                      exact
                    />
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}

            <NavGroup
              id="estate"
              label="Estate"
              defaultOpen
              items={estateLinks}
              action={
                canEdit && (
                  <SidebarGroupAction title="New site" onClick={openNewSite} className="right-8">
                    <Plus />
                    <span className="sr-only">New site</span>
                  </SidebarGroupAction>
                )
              }
            >
              {/* The tree is too wide for the icon rail; the links below it stay. */}
              <div className="group-data-[collapsible=icon]:hidden">
                <EstateTree />
              </div>
            </NavGroup>
            <NavGroup id="monitor" label="Monitor" defaultOpen items={monitor} />
            <NavGroup id="assets" label="Assets" items={assets} />
            <NavGroup id="maintenance" label="Maintenance" items={maintenance} />
            <NavGroup id="configuration" label="Configuration" items={configuration} />
            <NavGroup id="analytics" label="Analytics" items={analytics} />
            <NavGroup id="support" label="Support" defaultOpen items={support} />
          </>
        }

        {canSeeTeam && !scoped && (
          <SidebarGroup>
            <SidebarGroupLabel>Organisation</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <NavItem
                  href={`${base}/team`}
                  icon={Users}
                  label="Team"
                  count={joinRequests.data}
                />
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
