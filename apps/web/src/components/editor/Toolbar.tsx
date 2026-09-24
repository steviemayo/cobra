'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RoomModel } from '@kestrel/model';
import { useTRPC } from '@/trpc/client';
import type { SaveStatus } from './use-room-editor';
import { TextInput, btnCls, ghostBtnCls } from './ui';

const STATUS_TEXT: Record<SaveStatus, { text: string; tone: string }> = {
  saved: { text: 'All changes saved', tone: 'text-emerald-300' },
  dirty: { text: 'Unsaved changes…', tone: 'text-slate-300' },
  saving: { text: 'Saving…', tone: 'text-slate-300' },
  invalid: { text: 'Not saved: a required field is empty', tone: 'text-amber-300' },
  conflict: { text: 'Someone else changed this draft', tone: 'text-red-300' },
  error: { text: 'Save failed — will retry on next change', tone: 'text-red-300' },
};

export function SaveStatusBadge({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  const s = STATUS_TEXT[status];
  return (
    <span className={`text-xs ${s.tone}`}>
      {s.text}
      {status === 'conflict' && (
        <button className="ml-2 underline" onClick={() => window.location.reload()}>
          Reload latest
        </button>
      )}
      {status === 'error' && (
        <button className="ml-2 underline" onClick={onRetry}>
          Retry now
        </button>
      )}
    </span>
  );
}

type Panel = 'none' | 'version' | 'versions' | 'template';

export function Toolbar({
  orgId,
  roomId,
  status,
  flush,
  onRestore,
}: {
  orgId: string;
  roomId: string;
  status: SaveStatus;
  flush: () => Promise<void>;
  onRestore: (model: RoomModel, revision: number) => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = useState<Panel>('none');
  const [label, setLabel] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');

  const blocked = status === 'conflict' || status === 'invalid';
  const versions = useQuery({
    ...trpc.draft.versions.queryOptions({ orgId, roomId }),
    enabled: open === 'versions',
    staleTime: 0,
  });

  const saveVersion = useMutation(
    trpc.draft.saveVersion.mutationOptions({
      onSuccess: () => {
        setNote('Version saved');
        setLabel('');
        setOpen('none');
        void qc.invalidateQueries({ queryKey: trpc.draft.versions.queryKey() });
      },
    }),
  );
  const restore = useMutation(
    trpc.draft.restoreVersion.mutationOptions({
      onSuccess: (res) => {
        onRestore(res.model, res.revision);
        setNote('Version restored');
        setOpen('none');
      },
    }),
  );
  const createTemplate = useMutation(
    trpc.template.createFromRoom.mutationOptions({
      onSuccess: () => {
        setNote('Template saved');
        setName('');
        setOpen('none');
        void qc.invalidateQueries({ queryKey: trpc.template.list.queryKey() });
      },
    }),
  );

  const toggle = (p: Panel) => {
    setNote('');
    setOpen(open === p ? 'none' : p);
  };
  const error = saveVersion.error ?? restore.error ?? createTemplate.error;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button className={ghostBtnCls} disabled={blocked} onClick={() => toggle('version')}>
          Save version
        </button>
        <button className={ghostBtnCls} disabled={blocked} onClick={() => toggle('versions')}>
          Versions
        </button>
        <button className={ghostBtnCls} disabled={blocked} onClick={() => toggle('template')}>
          Save as template
        </button>
        {note && <span className="text-xs text-emerald-300">{note}</span>}
      </div>
      {error && <p className="text-sm text-red-300">{error.message}</p>}

      {open === 'version' && (
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            await flush();
            saveVersion.mutate({ orgId, roomId, label });
          }}
        >
          <TextInput value={label} onChange={setLabel} placeholder="Label (optional)" />
          <button className={btnCls} disabled={saveVersion.isPending}>
            Save
          </button>
        </form>
      )}

      {open === 'template' && (
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            await flush();
            createTemplate.mutate({ orgId, roomId, name, description: '' });
          }}
        >
          <TextInput value={name} onChange={setName} required placeholder="Template name" />
          <button className={btnCls} disabled={createTemplate.isPending}>
            Save template
          </button>
        </form>
      )}

      {open === 'versions' && (
        <div className="max-w-xl space-y-1 rounded-lg border border-slate-800 p-2">
          {versions.isPending && <p className="text-xs text-slate-400">Loading…</p>}
          {versions.data?.length === 0 && (
            <p className="text-xs text-slate-400">No saved versions yet.</p>
          )}
          {versions.data?.map((v) => (
            <div key={v.id} className="flex items-center justify-between gap-3 text-sm">
              <span>
                {v.label || 'Untitled version'}{' '}
                <span className="text-xs text-slate-500">
                  rev {v.revision} · {new Date(v.createdAt).toLocaleString()}
                </span>
              </span>
              <button
                className={ghostBtnCls}
                disabled={restore.isPending}
                onClick={async () => {
                  await flush();
                  restore.mutate({ orgId, roomId, versionId: v.id });
                }}
              >
                Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
