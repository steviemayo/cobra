'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import {
  Activity,
  AlertTriangle,
  BellRing,
  Building2,
  DoorOpen,
  LayoutDashboard,
  LayoutTemplate,
  LifeBuoy,
  Link2,
  Moon,
  Plus,
  Rocket,
  Router,
  Settings,
  Store,
  Users,
} from 'lucide-react';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { useEstate } from '@/lib/use-estate';
import { useDialogs } from './dialogs';
import { orgPath, useOrg } from './org-context';

const PaletteContext = createContext<{ open: () => void } | null>(null);
export const usePalette = () => {
  const ctx = useContext(PaletteContext);
  if (!ctx) throw new Error('usePalette must be used inside CommandMenu');
  return ctx;
};

export function CommandMenu({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { orgId, canEdit, canSeeTeam } = useOrg();
  const { sites, rooms } = useEstate();
  const { openNewSite, openNewRoom } = useDialogs();
  const { resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const run = useCallback((fn: () => void) => {
    setOpen(false);
    fn();
  }, []);
  const go = (path: string) => run(() => router.push(orgPath(orgId, path)));
  const api = useMemo(() => ({ open: () => setOpen(true) }), []);

  return (
    <PaletteContext.Provider value={api}>
      {children}
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search Kestrel"
        description="Jump to a site, room or page"
      >
        <Command>
          <CommandInput placeholder="Search sites, rooms and pages…" />
          <CommandList>
            <CommandEmpty>Nothing found.</CommandEmpty>
            <CommandGroup heading="Go to">
              <CommandItem onSelect={() => go('')}>
                <LayoutDashboard /> Overview
              </CommandItem>
              <CommandItem onSelect={() => go('/sites')}>
                <Building2 /> Sites
              </CommandItem>
              <CommandItem onSelect={() => go('/rooms')}>
                <DoorOpen /> Rooms
              </CommandItem>
              {canEdit && (
                <CommandItem onSelect={() => go('/templates')}>
                  <LayoutTemplate /> Templates
                </CommandItem>
              )}
              <CommandItem onSelect={() => go('/gateways')}>
                <Router /> Gateways
              </CommandItem>
              <CommandItem onSelect={() => go('/deployments')}>
                <Rocket /> Deployments
              </CommandItem>
              {canEdit && (
                <CommandItem onSelect={() => go('/marketplace')}>
                  <Store /> Marketplace
                </CommandItem>
              )}
              <CommandItem onSelect={() => go('/combinations')}>
                <Link2 /> Combined rooms
              </CommandItem>
              <CommandItem onSelect={() => go('/monitoring')}>
                <Activity /> Monitoring
              </CommandItem>
              <CommandItem onSelect={() => go('/incidents')}>
                <AlertTriangle /> Incidents
              </CommandItem>
              <CommandItem onSelect={() => go('/tickets')}>
                <LifeBuoy /> Support requests
              </CommandItem>
              {canSeeTeam && (
                <>
                  <CommandItem onSelect={() => go('/team')}>
                    <Users /> Team
                  </CommandItem>
                  <CommandItem onSelect={() => go('/alerts')}>
                    <BellRing /> Alerts
                  </CommandItem>
                  <CommandItem onSelect={() => go('/settings/activity')}>
                    <Activity /> Activity log
                  </CommandItem>
                  <CommandItem onSelect={() => go('/settings')}>
                    <Settings /> Organisation settings
                  </CommandItem>
                </>
              )}
            </CommandGroup>
            {sites.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Sites">
                  {sites.map((s) => (
                    <CommandItem
                      key={s.id}
                      value={`site ${s.name}`}
                      onSelect={() => go(`/sites/${s.id}`)}
                    >
                      <Building2 /> {s.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
            {rooms.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Rooms">
                  {rooms.map((r) => (
                    <CommandItem
                      key={r.id}
                      value={`room ${r.name} ${r.site.name}`}
                      onSelect={() => go(`/rooms/${r.id}`)}
                    >
                      <DoorOpen /> {r.name}
                      <span className="ml-auto text-xs text-muted-foreground">{r.site.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
            <CommandSeparator />
            <CommandGroup heading="Actions">
              {canEdit && (
                <>
                  <CommandItem onSelect={() => run(openNewSite)}>
                    <Plus /> New site
                  </CommandItem>
                  <CommandItem onSelect={() => run(() => openNewRoom())}>
                    <Plus /> New room
                  </CommandItem>
                </>
              )}
              <CommandItem
                onSelect={() => run(() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'))}
              >
                <Moon /> Toggle dark mode
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </PaletteContext.Provider>
  );
}
