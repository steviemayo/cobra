'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useTRPC } from '@/trpc/client';

const WHOLE_ORG = 'org';

/**
 * Sign up to a daily briefing (status plus a short list of what to focus on) delivered to one of
 * the organisation's alert channels, for the whole organisation or one site.
 */
export function BriefingSetting() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, org } = useOrg();
  const mine = useQuery(trpc.briefing.mine.queryOptions({ orgId }));
  const [channelId, setChannelId] = useState('');
  const [scope, setScope] = useState(WHOLE_ORG);
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.briefing.mine.queryKey() });

  const subscribe = useMutation(
    trpc.briefing.subscribe.mutationOptions({
      onSuccess: async () => {
        await refresh();
        setChannelId('');
        toast.success('You will get the daily briefing');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const unsubscribe = useMutation(
    trpc.briefing.unsubscribe.mutationOptions({
      onSuccess: refresh,
      onError: (e) => toast.error(e.message),
    }),
  );
  const sendNow = useMutation(
    trpc.briefing.sendNow.mutationOptions({
      onSuccess: async (r) => {
        await refresh();
        if (r.status === 'sent') toast.success('Briefing sent');
        else toast.error(r.error ?? `Briefing ${r.status}`);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (!mine.data) return null;
  const { channels, sites, subscriptions } = mine.data;
  const channelName = (id: string) => channels.find((c) => c.id === id);
  const siteName = (id: string | null) =>
    id ? (sites.find((s) => s.id === id)?.name ?? 'Site') : org.name;

  return (
    <div className="space-y-3 rounded-md border px-4 py-3">
      <div>
        <Label>Daily briefing</Label>
        <p className="text-sm text-muted-foreground">
          Every morning: where things stand and the few items most worth your attention. Sent to the
          alert channel you choose.
        </p>
      </div>

      {subscriptions.length > 0 && (
        <ul className="space-y-2">
          {subscriptions.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">
                {siteName(s.siteId)} → {channelName(s.channelId)?.name ?? 'Unavailable channel'}
              </span>
              <span className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={sendNow.isPending}
                  onClick={() => sendNow.mutate({ orgId, id: s.id })}
                >
                  Send now
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={unsubscribe.isPending}
                  onClick={() => unsubscribe.mutate({ orgId, id: s.id })}
                >
                  Stop
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {channels.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Add an email, text, Teams or webhook alert channel first, then come back to sign up.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <SimpleSelect
            className="w-56"
            value={channelId}
            onValueChange={setChannelId}
            placeholder="Send to…"
            options={channels.map((c) => ({ value: c.id, label: `${c.name} (${c.type})` }))}
          />
          <SimpleSelect
            className="w-48"
            value={scope}
            onValueChange={setScope}
            options={[
              { value: WHOLE_ORG, label: 'Whole organisation' },
              ...sites.map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
          <Button
            size="sm"
            disabled={!channelId || subscribe.isPending}
            onClick={() =>
              subscribe.mutate({ orgId, channelId, siteId: scope === WHOLE_ORG ? null : scope })
            }
          >
            Sign up
          </Button>
        </div>
      )}
    </div>
  );
}
