'use client';
import { useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Cable } from 'lucide-react';
import { toast } from 'sonner';
import type { PanelClient, PanelIntent, PanelViewModel } from '@kestrel/model';
import { EMPTY_VIEW, PanelApp, themeFromBranding } from '@kestrel/panel-ui';
import '@kestrel/panel-ui/panel.css';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer } from '@/components/common/page-header';
import { useOrg } from '@/components/shell/org-context';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/trpc/client';

/** A panel client whose state comes from the cloud and whose intents go to the cloud. */
class CloudPanelClient implements PanelClient {
  private vm: PanelViewModel = EMPTY_VIEW;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly send: (intent: PanelIntent) => void) {}

  set(vm: PanelViewModel) {
    this.vm = vm;
    for (const l of this.listeners) l();
  }
  getSnapshot() {
    return this.vm;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  dispatch(intent: PanelIntent) {
    this.send(intent);
  }
}

/**
 * The room's real control panel, in the portal. The state comes from the gateway through the
 * cloud, so the first connection can take up to half a minute; after that it follows within a
 * second or two.
 */
export function RoomControl({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const snapshot = useQuery({
    ...trpc.control.snapshot.queryOptions({ orgId, roomId }),
    refetchInterval: 1_000,
    // Keep asking while the tab is in the background too, so the room stays connected.
    refetchIntervalInBackground: false,
  });
  const intent = useMutation(
    trpc.control.intent.mutationOptions({ onError: (e) => toast.error(e.message) }),
  );
  const sendRef = useRef(intent.mutate);
  sendRef.current = intent.mutate;

  const client = useMemo(
    () => new CloudPanelClient((i) => sendRef.current({ orgId, roomId, intent: i })),
    [orgId, roomId],
  );
  const vm = snapshot.data?.vm;
  useEffect(() => {
    if (vm) client.set(vm);
  }, [vm, client]);
  const theme = useMemo(
    () => themeFromBranding(snapshot.data?.branding),
    [snapshot.data?.branding],
  );

  if (snapshot.isPending)
    return (
      <PageContainer className="max-w-xl">
        <Skeleton className="h-96 w-full" />
      </PageContainer>
    );
  if (!snapshot.data?.hasGateway)
    return (
      <PageContainer>
        <EmptyState
          icon={Cable}
          title="This room can’t be controlled from here yet"
          description="It needs to be set up on a gateway and have a design deployed."
        />
      </PageContainer>
    );

  const live = snapshot.data.live;
  return (
    <PageContainer className="max-w-xl">
      <div className="space-y-2">
        <div
          className="h-[600px] overflow-auto rounded-2xl border-[5px] border-foreground/85 bg-black"
          aria-busy={!live}
        >
          {vm ? (
            <PanelApp client={client} theme={theme} language={snapshot.data?.branding.language} />
          ) : (
            <div className="grid h-full place-items-center p-6 text-center text-sm text-white/70">
              Connecting to the room… this can take up to 30 seconds the first time.
            </div>
          )}
        </div>
        <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <span
            aria-hidden
            className={
              live
                ? 'size-1.5 rounded-full bg-success'
                : 'size-1.5 animate-pulse rounded-full bg-warning'
            }
          />
          {live ? 'Connected to the room' : vm ? 'Reconnecting to the room…' : 'Connecting…'}
        </p>
      </div>
    </PageContainer>
  );
}
