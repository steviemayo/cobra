'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';

export interface DelegationInfo {
  status: 'none' | 'requested' | 'active' | 'ending';
  billedBy: 'self' | 'provider';
  provider: { id: string; name: string } | null;
  requestedAt: Date | null;
  declineReason: string | null;
  handoverAt: Date | null;
  endsAt: Date | null;
  connected: { id: string; name: string }[];
}

type Who = 'kestrel' | 'provider';

/**
 * Who pays for Kestrel: the organisation directly (the default), or a connected service provider.
 * Picking a provider changes nothing by itself: the owner reads what will happen and confirms, the
 * provider has to accept, and the organisation keeps paying directly until then (BD-5).
 */
export function WhoPays({
  delegation: d,
  directEnd,
}: {
  delegation: DelegationInfo;
  /** When the organisation's own subscription ends, if it has a live one. */
  directEnd: Date | null;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const [who, setWho] = useState<Who>('kestrel');
  const [providerId, setProviderId] = useState('');
  const [confirmAsk, setConfirmAsk] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: trpc.billing.status.queryKey() });
  const fail = (e: { message: string }) => toast.error(e.message);
  const ask = useMutation(
    trpc.billing.requestDelegation.mutationOptions({
      onSuccess: async () => {
        setConfirmAsk(false);
        setWho('kestrel');
        await refresh();
        toast.success('Request sent. Nothing changes until your provider accepts.');
      },
      onError: fail,
    }),
  );
  const cancel = useMutation(
    trpc.billing.cancelDelegationRequest.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.message('Request cancelled. You still pay Kestrel directly.');
      },
      onError: fail,
    }),
  );
  const end = useMutation(
    trpc.billing.endDelegation.mutationOptions({
      onSuccess: async (res) => {
        setConfirmEnd(false);
        await refresh();
        toast.success(
          res.outcome === 'stopped'
            ? 'Done. You pay Kestrel directly again.'
            : 'Done. Your provider’s billing will stop at the end of its period.',
        );
      },
      onError: fail,
    }),
  );

  const chosen = d.connected.find((c) => c.id === providerId);
  const noProviders = d.connected.length === 0;

  if (d.status === 'active' || d.status === 'ending') {
    const name = d.provider?.name ?? 'Your provider';
    const notStarted = d.status === 'active' && !!d.handoverAt && d.handoverAt > new Date();
    return (
      <section className="space-y-3 rounded-lg border p-4" aria-label="Who pays">
        <div>
          <div className="text-sm text-muted-foreground">Who pays for Kestrel</div>
          <div className="text-lg font-semibold">
            {d.status === 'ending' ? `${name} (ending)` : name}
          </div>
        </div>
        {d.status === 'ending' ? (
          <p className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
            {name} stops paying for Kestrel on{' '}
            {d.endsAt ? formatDate(d.endsAt) : 'the end of its period'}. To keep your plan, choose
            one below to pay Kestrel directly from then. You are not charged before that date.
            Otherwise your account drops to monitoring only.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {name} pays Kestrel for your rooms and bills you separately, so there is nothing to
              pay here. Ask {name} about price and invoices.
              {notStarted &&
                ` Their billing starts on ${formatDate(d.handoverAt!)}, when your own subscription ends.`}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={end.isPending}
              onClick={() => setConfirmEnd(true)}
            >
              {end.isPending && <Spinner />}
              Stop {name} paying for Kestrel
            </Button>
          </>
        )}
        <ConfirmDialog
          open={confirmEnd}
          onOpenChange={setConfirmEnd}
          title={`Stop ${name} paying for Kestrel?`}
          destructive
          confirmLabel="Stop their billing"
          description={
            notStarted
              ? `${name} has not started charging yet, so ending now keeps your current subscription running exactly as it is.`
              : `${name}’s billing stops at the end of its current period${
                  d.endsAt ? ` (${formatDate(d.endsAt)})` : ''
                }. To keep your plan you need to set up direct billing before then. Otherwise your account drops to monitoring only. Nothing is deleted.`
          }
          onConfirm={() => end.mutate({ orgId })}
        />
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label="Who pays">
      <div>
        <div className="text-sm font-medium">Who pays for Kestrel?</div>
        <p className="text-sm text-muted-foreground">
          {d.status === 'requested'
            ? `Waiting for ${d.provider?.name ?? 'your provider'} to accept. You keep paying Kestrel directly until they do.`
            : 'Pay Kestrel yourself, or let a service provider you are connected to pay and bill you.'}
        </p>
      </div>

      {d.status === 'requested' ? (
        <Button
          variant="outline"
          size="sm"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate({ orgId })}
        >
          {cancel.isPending && <Spinner />}
          Cancel request
        </Button>
      ) : (
        <>
          {d.declineReason && (
            <p className="rounded-md border p-3 text-sm">
              Your last request was declined: {d.declineReason}
            </p>
          )}
          <div
            role="radiogroup"
            aria-label="Who pays for Kestrel"
            className="grid gap-3 sm:grid-cols-2"
          >
            <ChoiceCard
              selected={who === 'kestrel'}
              onSelect={() => setWho('kestrel')}
              title="Kestrel, directly"
              body="You pay Kestrel by card or invoice. This is the default."
            />
            <ChoiceCard
              selected={who === 'provider'}
              disabled={noProviders}
              onSelect={() => setWho('provider')}
              title="A service provider"
              body={
                noProviders
                  ? 'No provider is connected yet.'
                  : 'A provider you are connected to pays Kestrel and bills you themselves.'
              }
              extra={
                noProviders ? (
                  <Link
                    href={orgPath(orgId, '/settings')}
                    className="text-sm underline underline-offset-2"
                  >
                    Connect a provider first
                  </Link>
                ) : null
              }
            />
          </div>

          {who === 'provider' && !noProviders && (
            <div className="space-y-3 rounded-md border bg-muted/30 p-3">
              <SimpleSelect
                className="w-full max-w-sm"
                value={providerId}
                onValueChange={setProviderId}
                placeholder="Choose a provider"
                options={d.connected.map((c) => ({ value: c.id, label: c.name }))}
              />
              {chosen && (
                <>
                  <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                    <li>
                      {chosen.name} pays Kestrel for your rooms and bills you separately. Kestrel
                      stops billing you.
                    </li>
                    {directEnd && (
                      <li>
                        Your current subscription ends on {formatDate(directEnd)}. Their billing
                        starts then, so there is no gap and you are never billed twice.
                      </li>
                    )}
                    <li>
                      They see your room count and plan. They never see your card or invoices.
                    </li>
                    <li>You can switch back at any time.</li>
                  </ul>
                  <Button onClick={() => setConfirmAsk(true)} disabled={ask.isPending}>
                    {ask.isPending && <Spinner />}
                    Ask {chosen.name} to handle billing
                  </Button>
                </>
              )}
            </div>
          )}
          <ConfirmDialog
            open={confirmAsk}
            onOpenChange={setConfirmAsk}
            title={`Ask ${chosen?.name ?? 'your provider'} to handle billing?`}
            confirmLabel="Send request"
            description="This only sends a request. Nothing changes, and you keep paying Kestrel directly, until they accept."
            onConfirm={() => chosen && ask.mutate({ orgId, providerOrgId: chosen.id })}
          />
        </>
      )}
    </section>
  );
}

function ChoiceCard({
  selected,
  disabled,
  onSelect,
  title,
  body,
  extra,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  body: string;
  extra?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        selected && 'border-brand bg-muted/40',
        disabled && 'opacity-70',
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={disabled}
        onClick={onSelect}
        className="flex w-full items-start gap-3 text-left disabled:cursor-not-allowed"
      >
        <span
          aria-hidden
          className={cn(
            'mt-1 size-4 shrink-0 rounded-full border',
            selected && 'border-brand bg-brand',
          )}
        />
        <span>
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-sm text-muted-foreground">{body}</span>
        </span>
      </button>
      {extra && <div className="mt-2 pl-7">{extra}</div>}
    </div>
  );
}
