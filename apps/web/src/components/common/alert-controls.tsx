'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BellOff, ChevronDown, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { dateTime } from '@/components/common/health';
import { useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTRPC } from '@/trpc/client';

export type MuteScope = 'org' | 'site' | 'room';

export interface AlertState {
  /** What is holding alert notifications back here: this item itself, something above it, or nothing. */
  mutedBy: MuteScope | null;
  mutedUntil: Date | string | null;
  inMaintenance: boolean;
}

const WHERE: Record<MuteScope, string> = {
  org: 'the organisation',
  site: 'its site',
  room: 'this room',
};

/** The sentence a muted bell explains itself with. */
export function muteText(by: MuteScope, until: Date | string | null): string {
  return `Alerts muted by ${WHERE[by]}${until ? ` until ${dateTime(until)}` : ' until switched back on'}. Incidents are still raised.`;
}

/** A small muted-bell for the tree, a table row or a header. */
export function MutedBell({
  by,
  until,
  className,
}: {
  by: MuteScope;
  until?: Date | string | null;
  className?: string;
}) {
  const text = muteText(by, until ?? null);
  return (
    <span title={text} className={className}>
      <BellOff className="size-3.5 text-muted-foreground" aria-label={text} />
    </span>
  );
}

const MUTE_FOR = [
  { label: 'For 1 hour', hours: 1 },
  { label: 'For 8 hours', hours: 8 },
  { label: 'For 24 hours', hours: 24 },
  { label: 'For 7 days', hours: 24 * 7 },
  { label: 'Until I switch it back on', hours: null },
] as const;
const MAINTENANCE_FOR = [
  { label: 'For 1 hour', hours: 1 },
  { label: 'For 4 hours', hours: 4 },
  { label: 'For 24 hours', hours: 24 },
  { label: 'For 7 days', hours: 24 * 7 },
] as const;

/**
 * Mute alerts, or put into maintenance mode, for a room, a site or the whole organisation. Muting only
 * holds back notifications (the incident is still raised). Maintenance mode raises nothing at all.
 */
export function AlertControls({
  scope,
  scopeId,
  state,
  size = 'sm',
}: {
  scope: MuteScope;
  scopeId?: string;
  state: AlertState;
  size?: 'sm' | 'default';
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport } = useOrg();
  const done = async (msg: string) => {
    toast.success(msg);
    await Promise.all([
      qc.invalidateQueries({ queryKey: trpc.monitoring.estate.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.support.windows.queryKey() }),
    ]);
  };
  const mute = useMutation(
    trpc.support.setMute.mutationOptions({
      onError: (e) => toast.error(e.message),
    }),
  );
  const start = useMutation(
    trpc.support.startMaintenance.mutationOptions({ onError: (e) => toast.error(e.message) }),
  );
  const end = useMutation(
    trpc.support.endMaintenance.mutationOptions({ onError: (e) => toast.error(e.message) }),
  );
  if (!canSupport) return null;
  const base = { orgId, scope, scopeId: scopeId ?? null };
  const own = state.mutedBy === scope;
  const inherited = state.mutedBy !== null && !own;
  const setMute = async (hours: number | null) => {
    await mute.mutateAsync({
      ...base,
      muted: true,
      until: hours === null ? null : new Date(Date.now() + hours * 3_600_000),
    });
    await done('Alerts muted');
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size={size}>
            {state.inMaintenance ? <Wrench /> : <BellOff />}
            {state.inMaintenance ? 'In maintenance' : state.mutedBy ? 'Muted' : 'Alerts'}
            <ChevronDown />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Alert notifications</DropdownMenuLabel>
          {inherited && (
            <p className="px-2 pb-1 text-xs text-muted-foreground">
              {muteText(state.mutedBy!, state.mutedUntil)} Change it there.
            </p>
          )}
          {own ? (
            <DropdownMenuItem
              onClick={async () => {
                await mute.mutateAsync({ ...base, muted: false });
                await done('Alerts switched back on');
              }}
            >
              Switch alerts back on
              {state.mutedUntil ? ` (muted until ${dateTime(state.mutedUntil)})` : ''}
            </DropdownMenuItem>
          ) : (
            MUTE_FOR.map((o) => (
              <DropdownMenuItem key={o.label} onClick={() => setMute(o.hours)}>
                Mute {o.label.toLowerCase()}
              </DropdownMenuItem>
            ))
          )}
          <p className="px-2 pt-1 text-xs text-muted-foreground">
            Muting holds back emails and messages only. Problems are still recorded.
          </p>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Maintenance mode</DropdownMenuLabel>
          {state.inMaintenance ? (
            <DropdownMenuItem
              onClick={async () => {
                await end.mutateAsync(base);
                await done('Maintenance mode ended');
              }}
            >
              End maintenance mode
            </DropdownMenuItem>
          ) : (
            MAINTENANCE_FOR.map((o) => (
              <DropdownMenuItem
                key={o.label}
                onClick={async () => {
                  await start.mutateAsync({ ...base, hours: o.hours });
                  await done('Maintenance mode started');
                }}
              >
                Start {o.label.toLowerCase()}
              </DropdownMenuItem>
            ))
          )}
          <p className="px-2 pt-1 text-xs text-muted-foreground">
            Nothing is raised, alerted or ticketed while it is on.
          </p>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Badges for the header of a room or site. */
export function AlertBadges({ state }: { state: AlertState }) {
  return (
    <>
      {state.mutedBy && (
        <Badge variant="secondary" title={muteText(state.mutedBy, state.mutedUntil)}>
          <BellOff className="size-3" /> Alerts muted
        </Badge>
      )}
      {state.inMaintenance && (
        <Badge variant="secondary">
          <Wrench className="size-3" /> In maintenance
        </Badge>
      )}
    </>
  );
}
