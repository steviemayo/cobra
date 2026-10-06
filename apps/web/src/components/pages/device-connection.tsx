'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { useTRPC } from '@/trpc/client';
import { slotsFor, type BindingSlot, type DeviceControl } from '@kestrel/model';

const NO_SET = '__none';
const DEFAULT_CHOICE = '__default';

/** What a device's driver needs to connect: the address and port, and any login. */
export function connectionSlots(control: DeviceControl | null | undefined): BindingSlot[] {
  if (!control) return [];
  const slots = slotsFor({ control, settings: {} } as never);
  // A custom driver we cannot read here still gets the usual three.
  return slots.length > 0 || control.kind !== 'driver'
    ? slots
    : [
        { key: 'host', label: 'Address (IP or hostname)', scope: 'binding', required: true },
        { key: 'username', label: 'Username', scope: 'binding', required: false },
        { key: 'password', label: 'Password', scope: 'secret', required: false },
      ];
}

export type ConnectionDraft = {
  values: Record<string, string>;
  secrets: Record<string, string>;
  credentialSetId: string;
};
export const emptyConnection = (values: Record<string, string> = {}): ConnectionDraft => ({
  values,
  secrets: {},
  credentialSetId: NO_SET,
});

/** What to send: addresses always, logins only when something was typed or a saved login is picked. */
export function connectionPatch(slots: BindingSlot[], draft: ConnectionDraft) {
  const values: Record<string, string | number | boolean> = {};
  const secrets: Record<string, string | number> = {};
  for (const s of slots) {
    if (s.scope === 'secret') {
      const v = draft.secrets[s.key];
      if (v) secrets[s.key] = v;
    } else {
      const v = draft.values[s.key]?.trim();
      if (!v) continue;
      // A drop-down keeps the type of the option it stands for (a number, true or false).
      const picked = s.options?.find((o) => String(o.value) === v);
      values[s.key] = picked ? picked.value : s.key === 'port' && /^\d+$/.test(v) ? Number(v) : v;
    }
  }
  return {
    values,
    secrets,
    credentialSetId: draft.credentialSetId === NO_SET ? null : draft.credentialSetId,
  };
}

export const connectionMissing = (slots: BindingSlot[], draft: ConnectionDraft) =>
  slots.some((s) => s.required && s.scope !== 'secret' && !draft.values[s.key]?.trim());

/** The address and login fields for one driver. Logins are written and never read back. */
export function ConnectionFields({
  slots,
  draft,
  onChange,
  loginSet,
}: {
  slots: BindingSlot[];
  draft: ConnectionDraft;
  onChange: (d: ConnectionDraft) => void;
  /** A login is already stored; leaving its boxes empty keeps it. */
  loginSet?: boolean;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const hasSecret = slots.some((s) => s.scope === 'secret');
  const sets = useQuery({
    ...trpc.binding.credentialSets.list.queryOptions({ orgId }),
    enabled: hasSecret,
    retry: false,
  });
  if (slots.length === 0)
    return (
      <p className="text-sm text-muted-foreground">This driver needs no connection settings.</p>
    );
  const usingSet = draft.credentialSetId !== NO_SET;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {slots
          .filter((s) => s.scope !== 'secret')
          .map((s) => (
            <div key={s.key} className="space-y-1.5">
              <Label className="text-xs">
                {s.label}
                {s.required ? '' : ' (optional)'}
              </Label>
              {s.options ? (
                <SimpleSelect
                  value={draft.values[s.key] || DEFAULT_CHOICE}
                  onValueChange={(v) =>
                    onChange({
                      ...draft,
                      values: { ...draft.values, [s.key]: v === DEFAULT_CHOICE ? '' : v },
                    })
                  }
                  options={[
                    ...(s.required ? [] : [{ value: DEFAULT_CHOICE, label: 'Default' }]),
                    ...s.options.map((o) => ({ value: String(o.value), label: o.label })),
                  ]}
                />
              ) : (
                <Input
                  value={draft.values[s.key] ?? ''}
                  onChange={(e) =>
                    onChange({ ...draft, values: { ...draft.values, [s.key]: e.target.value } })
                  }
                  maxLength={200}
                />
              )}
            </div>
          ))}
      </div>
      {hasSecret && (
        <div className="space-y-3 rounded-md border p-3">
          <div className="text-xs font-medium">Login</div>
          {(sets.data?.length ?? 0) > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs">Use a saved login</Label>
              <SimpleSelect
                value={draft.credentialSetId}
                onValueChange={(v) => onChange({ ...draft, credentialSetId: v })}
                options={[
                  { value: NO_SET, label: 'Enter one for this device' },
                  ...(sets.data ?? []).map((c) => ({ value: c.id, label: c.name })),
                ]}
              />
            </div>
          )}
          {!usingSet && (
            <div className="grid gap-3 sm:grid-cols-2">
              {slots
                .filter((s) => s.scope === 'secret')
                .map((s) => (
                  <div key={s.key} className="space-y-1.5">
                    <Label className="text-xs">{s.label}</Label>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={draft.secrets[s.key] ?? ''}
                      placeholder={loginSet ? 'Set. Type to replace' : ''}
                      onChange={(e) =>
                        onChange({
                          ...draft,
                          secrets: { ...draft.secrets, [s.key]: e.target.value },
                        })
                      }
                    />
                  </div>
                ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Stored sealed and never shown again.{' '}
            {loginSet && !usingSet ? 'Fill in every login box when replacing one.' : ''}
          </p>
        </div>
      )}
    </div>
  );
}

/** The connection settings of a device already in the register. */
export function DeviceConnection({
  deviceId,
  control,
  values,
  hasLogin,
  credentialSetId,
  canEdit,
}: {
  deviceId: string;
  control: DeviceControl | null;
  values: unknown;
  hasLogin: boolean;
  credentialSetId: string | null;
  canEdit: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const slots = connectionSlots(control);
  const current: Record<string, string> = {};
  if (values && typeof values === 'object')
    for (const [k, v] of Object.entries(values as Record<string, unknown>))
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        current[k] = String(v);
  const [draft, setDraft] = useState<ConnectionDraft>({
    ...emptyConnection(current),
    credentialSetId: credentialSetId ?? NO_SET,
  });
  const save = useMutation(
    trpc.device.update.mutationOptions({
      onSuccess: async () => {
        toast.success('Connection saved. The gateway picks it up on its next check');
        setDraft((d) => ({ ...d, secrets: {} }));
        await qc.invalidateQueries({ queryKey: trpc.device.get.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (!control) return null;
  const patch = connectionPatch(slots, draft);
  const hasTyped = Object.keys(patch.secrets).length > 0;
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div>
        <h3 className="text-sm font-medium">Connection</h3>
        <p className="text-sm text-muted-foreground">
          How the gateway reaches this device.
          {hasLogin ? ' A login is stored.' : ''}
        </p>
      </div>
      <ConnectionFields slots={slots} draft={draft} onChange={setDraft} loginSet={hasLogin} />
      {canEdit && (
        <Button
          disabled={connectionMissing(slots, draft) || save.isPending}
          onClick={() =>
            save.mutate({
              orgId,
              deviceId,
              values: patch.values,
              credentialSetId: patch.credentialSetId,
              // A blank login leaves the stored one alone.
              ...(hasTyped ? { secrets: patch.secrets } : {}),
            })
          }
        >
          {save.isPending && <Spinner />}
          Save connection
        </Button>
      )}
    </section>
  );
}
