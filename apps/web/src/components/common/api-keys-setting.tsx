'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { timeAgo } from '@/lib/format';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Key = RouterOutputs['apikey']['list'][number];
type Expiry = 'never' | '30' | '90' | '365';

const status = (k: Key) =>
  k.revokedAt
    ? 'Revoked'
    : k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now()
      ? 'Expired'
      : k.expiresAt
        ? `Expires ${new Date(k.expiresAt).toLocaleDateString('en-AU')}`
        : 'No expiry';

/** Keys for the organisation's own systems to read its rooms and incidents (docs/public-api.md). */
export function ApiKeysSetting() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const keys = useQuery(trpc.apikey.list.queryOptions({ orgId }));
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<Expiry>('365');
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<Key | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.apikey.list.queryKey() });

  const create = useMutation(
    trpc.apikey.create.mutationOptions({
      onSuccess: async (made) => {
        setFresh(made.key);
        setCopied(false);
        setName('');
        await refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const revoke = useMutation(
    trpc.apikey.revoke.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Key revoked');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  // Not on this plan: say nothing here; the rest of Settings is unaffected.
  if (keys.isPending || keys.isError) return null;
  const active = keys.data.filter((k) => !k.revokedAt && (!k.expiresAt || new Date(k.expiresAt).getTime() > Date.now()));

  return (
    <section className="space-y-4 border-t pt-6">
      <div>
        <h2 className="text-sm font-medium">API keys</h2>
        <p className="text-sm text-muted-foreground">
          Let your own systems (a building system, a dashboard, a script) read your rooms and problems. Keys can look but not
          change anything. Send one as <code className="text-xs">Authorization: Bearer &lt;key&gt;</code> to{' '}
          <code className="text-xs">/api/v1/rooms</code> or <code className="text-xs">/api/v1/incidents</code>.
        </p>
      </div>

      {fresh && (
        <div className="space-y-2 rounded-md border border-success/40 bg-success/5 p-3">
          <p className="text-sm font-medium">Copy your new key now. It will not be shown again.</p>
          <div className="flex gap-2">
            <Input readOnly value={fresh} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () => {
                await navigator.clipboard.writeText(fresh);
                setCopied(true);
              }}
            >
              {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setFresh(null)}>
              Done
            </Button>
          </div>
        </div>
      )}

      {keys.data.length > 0 && (
        <ul className="divide-y rounded-md border text-sm">
          {keys.data.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>
                <span className="font-medium">{k.name}</span>
                <span className="ml-2 font-mono text-xs text-muted-foreground">{k.prefix}…</span>
                <span className="block text-xs text-muted-foreground">
                  {status(k)} · {k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : 'never used'}
                </span>
              </span>
              {!k.revokedAt && (
                <Button variant="ghost" size="xs" onClick={() => setRevoking(k)}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({ orgId, name, expiresInDays: expiry === 'never' ? null : (Number(expiry) as 30 | 90 | 365) });
        }}
      >
        <div className="min-w-48 flex-1 space-y-1.5">
          <Label htmlFor="key-name">Name</Label>
          <Input id="key-name" required placeholder="Building management system" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="key-expiry">Expires</Label>
          <SimpleSelect
            id="key-expiry"
            value={expiry}
            onValueChange={setExpiry}
            options={[
              { value: '30', label: 'In 30 days' },
              { value: '90', label: 'In 90 days' },
              { value: '365', label: 'In a year' },
              { value: 'never', label: 'Never' },
            ]}
          />
        </div>
        <Button type="submit" disabled={create.isPending || !name.trim() || active.length >= 10}>
          {create.isPending && <Spinner />}
          Make a key
        </Button>
      </form>

      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        destructive
        title={`Revoke “${revoking?.name}”?`}
        description="Anything using this key stops working straight away."
        confirmLabel="Revoke key"
        onConfirm={() => revoking && revoke.mutate({ orgId, keyId: revoking.id })}
      />
    </section>
  );
}
