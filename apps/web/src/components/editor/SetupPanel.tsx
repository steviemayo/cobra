'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { DeviceBindingView } from '@/server/bindings';
import { useOrg } from '@/components/shell/org-context';
import { useTRPC } from '@/trpc/client';
import { SetupTable } from './SetupTable';
import { Card, Label, btnCls, ghostBtnCls, inputCls, type PanelProps } from './ui';

// Where each device is and how to log in to it. These are kept out of the design, so templates
// carry none of them and an address can change without a new release. Logins are write-only: once
// saved they are never shown again, only "set".
export function SetupPanel({ roomId, model, update }: Pick<PanelProps, 'model' | 'update'> & { roomId: string }) {
  const trpc = useTRPC();
  const { orgId, canEdit } = useOrg();
  // Cards show one device at a time and can test a connection. The table is for filling many quickly.
  const [layout, setLayout] = useState<'cards' | 'table' | null>(null);
  const [tableDirty, setTableDirty] = useState(false);
  const view = useQuery({ ...trpc.binding.view.queryOptions({ orgId, roomId }), staleTime: 0, refetchOnWindowFocus: false });
  const sets = useQuery({
    ...trpc.binding.credentialSets.list.queryOptions({ orgId }),
    enabled: canEdit,
  });

  if (view.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (view.isError) return <p className="text-sm text-destructive">{view.error.message}</p>;
  const data = view.data;
  const pending = data.version !== null && data.hasGateway && data.reportedVersion !== data.version;
  // With many devices the table is the quicker way in, so it opens first.
  const shown = layout ?? (data.devices.length > 5 ? 'table' : 'cards');

  return (
    <div className="space-y-4">
      <div
        className={`rounded-lg border p-3 text-sm ${data.missing.length ? 'border-warning/60' : 'border-border'} bg-card`}
      >
        {data.missing.length ? (
          <>
            <div className="font-medium">Needs setup</div>
            <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
              {data.missing.map((m) => (
                <li key={`${m.deviceId}:${m.key}`}>
                  {m.deviceName}: {m.label}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-muted-foreground">This room can’t be deployed until these are filled in.</p>
          </>
        ) : (
          <div className="font-medium">Everything this room needs is filled in.</div>
        )}
        {pending && (
          <p className="mt-1 text-xs text-muted-foreground">
            Saved changes reach the room’s gateway within about a minute, with no new release.
          </p>
        )}
        {!data.canStoreLogins && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            This server has no secrets key, so logins can’t be saved separately yet.
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Enter addresses and logins here, not in a device’s driver settings. A value entered here wins over one in the settings.
        </p>
        <div className="inline-flex rounded-lg border border-border p-0.5 text-sm">
          {(['cards', 'table'] as const).map((l) => (
            <button
              key={l}
              type="button"
              className={`rounded-md px-3 py-1 ${shown === l ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
              onClick={() => {
                if (l === shown) return;
                if (tableDirty && !window.confirm('Discard the changes in the table that are not saved?')) return;
                setTableDirty(false);
                setLayout(l);
              }}
            >
              {l === 'cards' ? 'Cards' : 'Table'}
            </button>
          ))}
        </div>
      </div>
      {shown === 'table' ? (
        <SetupTable
          roomId={roomId}
          model={model}
          update={update}
          views={data.devices}
          sets={sets.data ?? []}
          canEdit={canEdit}
          onDirty={setTableDirty}
        />
      ) : (
        <>
          {data.devices.length === 0 && (
            <p className="text-sm text-muted-foreground">No device in this room needs an address or login.</p>
          )}
          {data.devices.map((d) => (
            <DeviceSetup
              roomId={roomId}
              key={`${d.deviceId}:${data.version}`}
              device={d}
              sets={sets.data ?? []}
              canEdit={canEdit}
              hasGateway={data.hasGateway}
            />
          ))}
        </>
      )}
    </div>
  );
}

function DeviceSetup({
  roomId,
  device,
  sets,
  canEdit,
  hasGateway,
}: {
  roomId: string;
  device: DeviceBindingView;
  sets: { id: string; name: string; fields: string[] }[];
  canEdit: boolean;
  hasGateway: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [setId, setSetId] = useState(device.credentialSetId ?? '');
  const hasSecret = device.slots.some((s) => s.scope === 'secret');
  const changed = Object.keys(typed).length > 0 || setId !== (device.credentialSetId ?? '');

  const save = useMutation(
    trpc.binding.saveDevice.mutationOptions({
      onSuccess: () => {
        toast.success(`Saved ${device.name}`);
        setTyped({});
        void qc.invalidateQueries({ queryKey: trpc.binding.view.queryKey() });
        void qc.invalidateQueries({ queryKey: trpc.binding.credentialSets.list.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const [testId, setTestId] = useState<string | null>(null);
  const test = useMutation(
    trpc.binding.test.mutationOptions({
      onSuccess: (r) => setTestId(r.commandId),
      onError: (e) => toast.error(e.message),
    }),
  );
  const result = useQuery({
    ...trpc.binding.testResult.queryOptions({ orgId, roomId, commandId: testId ?? '00000000-0000-4000-8000-000000000000' }),
    enabled: !!testId,
    refetchInterval: (q) => (q.state.data && ['succeeded', 'failed'].includes(q.state.data.status) ? false : 2000),
  });
  const status = result.data?.status;
  const testing = !!testId && !(status === 'succeeded' || status === 'failed');

  if (device.sharedFrom)
    return (
      <Card>
        <div className="text-sm font-medium">{device.name}</div>
        <p className="text-xs text-muted-foreground">
          This device is shared. Its address and login are kept on the shared device “{device.sharedFrom}”, under Shared devices.
        </p>
      </Card>
    );

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm font-medium">{device.name}</div>
        {!device.slots.some((s) => s.required && !s.isSet) ? null : (
          <span className="rounded bg-warning/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">Needs setup</span>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {device.slots.map((s) => (
          <Label key={s.key} text={`${s.label}${s.required ? ' (required)' : ''}`}>
            <div className="flex items-center gap-2">
              <input
                className={`${inputCls} min-w-0 flex-1`}
                type={s.scope === 'secret' ? 'password' : 'text'}
                autoComplete="off"
                disabled={!canEdit}
                placeholder={
                  s.scope === 'secret'
                    ? s.isSet
                      ? s.fromCredentialSet
                        ? 'Set by the credential set'
                        : 'Set. Type to replace'
                      : 'Not set'
                    : ''
                }
                value={typed[s.key] ?? (s.scope === 'binding' ? String(s.value ?? '') : '')}
                onChange={(e) => setTyped((t) => ({ ...t, [s.key]: e.target.value }))}
              />
              {canEdit && s.scope === 'secret' && s.isSet && !s.fromCredentialSet && (
                <button
                  type="button"
                  className={ghostBtnCls}
                  onClick={() => setTyped((t) => ({ ...t, [s.key]: '' }))}
                  title="Remove this login when you save"
                >
                  Clear
                </button>
              )}
            </div>
          </Label>
        ))}
      </div>
      {hasSecret && canEdit && (
        <Label text="Shared login">
          <select className={inputCls} value={setId} onChange={(e) => setSetId(e.target.value)}>
            <option value="">None: use this device’s own login</option>
            {sets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.fields.join(', ')})
              </option>
            ))}
          </select>
        </Label>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            className={btnCls}
            disabled={!changed || save.isPending}
            onClick={() =>
              save.mutate({
                orgId,
                roomId,
                deviceId: device.deviceId,
                ...(Object.keys(typed).length ? { set: typed } : {}),
                ...(setId !== (device.credentialSetId ?? '') ? { credentialSetId: setId || null } : {}),
              })
            }
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            className={ghostBtnCls}
            disabled={!hasGateway || changed || testing || test.isPending}
            title={
              !hasGateway
                ? 'Assign the room to a gateway first'
                : changed
                  ? 'Save first'
                  : 'Ask the gateway to check this device answers'
            }
            onClick={() => {
              setTestId(null);
              test.mutate({ orgId, roomId, deviceId: device.deviceId });
            }}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {status === 'succeeded' && <span className="text-xs text-emerald-700 dark:text-emerald-300">Answers</span>}
          {status === 'failed' && (
            <span className="text-xs text-destructive">{result.data?.error ?? 'Did not answer'}</span>
          )}
        </div>
      )}
    </Card>
  );
}
