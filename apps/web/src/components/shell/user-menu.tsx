'use client';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { ChevronsUpDown, LogOut, Monitor, Moon, Sun } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { createSupabaseBrowser } from '@/lib/supabase/client';
import { useOrg } from './org-context';

export function UserMenu() {
  const router = useRouter();
  const { user } = useOrg();
  const { theme, setTheme } = useTheme();

  async function signOut() {
    await createSupabaseBrowser().auth.signOut();
    router.replace('/login');
    router.refresh();
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-popup-open:bg-sidebar-accent"
                tooltip={user.email}
              />
            }
          >
            <Avatar className="size-8 rounded-md">
              <AvatarFallback className="rounded-md text-xs">
                {user.email.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="flex-1 truncate text-left text-sm">{user.email}</span>
            <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-64">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="truncate">{user.email}</DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Sun className="size-4" />
                Theme
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={theme ?? 'light'} onValueChange={setTheme}>
                  <DropdownMenuRadioItem value="light">
                    <Sun className="size-4" /> Light
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    <Moon className="size-4" /> Dark
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">
                    <Monitor className="size-4" /> System
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={signOut}>
              <LogOut className="size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
