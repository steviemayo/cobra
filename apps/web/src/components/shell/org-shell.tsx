'use client';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { AppSidebar } from './app-sidebar';
import { Breadcrumbs } from './breadcrumbs';
import { CommandMenu, usePalette } from './command-menu';
import { DialogsProvider } from './dialogs';
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
      <Separator orientation="vertical" className="mr-1 h-4" />
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
  children,
}: {
  orgId: string;
  orgs: OrgSummary[];
  user: { id: string; email: string };
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  return (
    <OrgProvider orgId={orgId} orgs={orgs} user={user}>
      <SidebarProvider defaultOpen={defaultOpen}>
        <DialogsProvider>
          <CommandMenu>
            <AppSidebar />
            <SidebarInset className="min-w-0">
              <TopBar />
              <div className="flex-1">{children}</div>
            </SidebarInset>
          </CommandMenu>
        </DialogsProvider>
      </SidebarProvider>
    </OrgProvider>
  );
}
