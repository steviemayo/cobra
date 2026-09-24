'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { RoomType } from '@kestrel/model';
import { useTRPC } from '@/trpc/client';
import { btnCls, ghostBtnCls } from './ui';

export function TemplatePicker({
  orgId,
  roomId,
  roomType,
  onCreated,
}: {
  orgId: string;
  roomId: string;
  roomType: RoomType;
  onCreated: () => void;
}) {
  const trpc = useTRPC();
  const templates = useQuery(trpc.template.list.queryOptions({ orgId }));
  const init = useMutation(trpc.draft.init.mutationOptions({ onSuccess: onCreated }));

  const start = (templateId?: string) => init.mutate({ orgId, roomId, templateId });
  const starters = templates.data?.starters.filter((t) => t.roomType === roomType) ?? [];
  const own = templates.data?.org.filter((t) => t.roomType === roomType) ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">Start this room from…</h2>
        <p className="text-sm text-slate-400">
          Pick a starting point. You can change everything afterwards.
        </p>
      </div>
      {init.error && <p className="text-sm text-red-300">{init.error.message}</p>}
      <div className="space-y-2">
        {starters.map((t) => (
          <div
            key={t.id}
            className="flex items-center justify-between gap-4 rounded-lg border border-slate-800 p-3"
          >
            <div>
              <div className="font-medium">{t.name}</div>
              <div className="text-sm text-slate-400">{t.description}</div>
            </div>
            <button className={btnCls} disabled={init.isPending} onClick={() => start(t.id)}>
              Use
            </button>
          </div>
        ))}
        {own.length > 0 && (
          <h3 className="pt-2 text-sm font-medium text-slate-300">
            Your organisation&apos;s templates
          </h3>
        )}
        {own.map((t) => (
          <div
            key={t.id}
            className="flex items-center justify-between gap-4 rounded-lg border border-slate-800 p-3"
          >
            <div>
              <div className="font-medium">{t.name}</div>
              {t.description && <div className="text-sm text-slate-400">{t.description}</div>}
            </div>
            <button className={ghostBtnCls} disabled={init.isPending} onClick={() => start(t.id)}>
              Use
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
