'use client';
import { useRouter } from 'next/navigation';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { ROLE_LABEL } from '@/lib/format';
import { orgPath, useOrg } from './org-context';

export function OrgAvatar({ name }: { name: string }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">
      {name.trim().slice(0, 2).toUpperCase()}
    </span>
  );
}

export function OrgSwitcher() {
  const router = useRouter();
  const { org, orgs } = useOrg();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-popup-open:bg-sidebar-accent"
                tooltip={org.name}
              />
            }
          >
            <OrgAvatar name={org.name} />
            <div className="grid flex-1 text-left leading-tight">
              <span className="truncate text-sm font-medium">{org.name}</span>
              <span className="truncate text-xs text-muted-foreground">{ROLE_LABEL[org.role]}</span>
            </div>
            <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            {(() => {
              // Your own organisations first (a provider's is its Internal estate), then customers you work in through a provider.
              const own = orgs.filter((o) => !o.via);
              const customers = orgs.filter((o) => o.via);
              const item = (o: (typeof orgs)[number]) => (
                <DropdownMenuItem key={o.id} onClick={() => router.push(orgPath(o.id))}>
                  <OrgAvatar name={o.name} />
                  <span className="flex-1 truncate">{o.name}</span>
                  {o.via ? (
                    <span className="truncate text-xs text-muted-foreground">via {o.via}</span>
                  ) : o.kind === 'msp' ? (
                    <span className="truncate text-xs text-muted-foreground">Internal estate</span>
                  ) : null}
                  {o.id === org.id && <Check className="size-4" />}
                </DropdownMenuItem>
              );
              return (
                <>
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Organisations</DropdownMenuLabel>
                    {own.map(item)}
                  </DropdownMenuGroup>
                  {customers.length > 0 && (
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>Customers</DropdownMenuLabel>
                      {customers.map(item)}
                    </DropdownMenuGroup>
                  )}
                </>
              );
            })()}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push('/onboarding?new=1')}>
              <Plus className="size-4" />
              Create organisation
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
