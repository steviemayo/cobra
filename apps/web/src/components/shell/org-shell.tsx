'use client';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { TrialBanner } from '@/components/common/plan-gate';
import { ViewAsBanner, type ViewAs } from './view-as-banner';
import { ViaProviderBanner } from './via-provider-banner';
import { AppSidebar } from './app-sidebar';
import { Breadcrumbs } from './breadcrumbs';
import { CommandMenu, usePalette } from './command-menu';
import { DialogsProvider } from './dialogs';
import { PortalAccent } from './portal-accent';
import { OrgProvider, type OrgSummary } from './org-context';
import { ThemeToggle } from './theme-toggle';

function SearchButton() {
  const { open } = usePalette();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={open}
      className="hidden w-56 justify-start gap-2 text-muted-foreground sm:flex"
    >
      <Search />
      <span className="flex-1 text-left">Search…</span>
      <Kbd>Ctrl K</Kbd>
    </Button>
  );
}

function TopBar() {
  const { open } = usePalette();
  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 h-4 data-vertical:self-center" />
      <div className="min-w-0 flex-1">
        <Breadcrumbs />
      </div>
      <SearchButton />
      <Button variant="ghost" size="icon" className="sm:hidden" aria-label="Search" onClick={open}>
        <Search />
      </Button>
      <ThemeToggle />
    </header>
  );
}

export function OrgShell({
  orgId,
  orgs,
  user,
  defaultOpen,
  viewAs,
  accent,
  children,
}: {
  orgId: string;
  orgs: OrgSummary[];
  user: { id: string; email: string };
  defaultOpen: boolean;
  /** Set when Kestrel staff are looking in through a support session. */
  viewAs?: ViewAs | null;
  /** The organisation's accent colour, if it set one. */
  accent?: string | null;
  children: React.ReactNode;
}) {
  return (
    <OrgProvider orgId={orgId} orgs={orgs} user={user}>
      <PortalAccent accent={accent} />
      <SidebarProvider defaultOpen={defaultOpen}>
        <DialogsProvider>
          <CommandMenu>
            <AppSidebar />
            <SidebarInset className="min-w-0">
              {viewAs && <ViewAsBanner session={viewAs} email={user.email} />}
              <ViaProviderBanner />
              <TopBar />
              <TrialBanner />
              <div className="flex-1">{children}</div>
            </SidebarInset>
          </CommandMenu>
        </DialogsProvider>
      </SidebarProvider>
    </OrgProvider>
  );
}
