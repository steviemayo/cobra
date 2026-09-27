'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { RoomType } from '@kestrel/model';
import { useTRPC } from '@/trpc/client';
import { MonitoredNotice } from './MonitoredNotice';
import { btnCls, ghostBtnCls } from './ui';

export function TemplatePicker({
  orgId,
  roomId,
  roomType,
  monitoredOnly = false,
  onCreated,
}: {
  orgId: string;
  roomId: string;
  roomType: RoomType;
  /** The plan has no control: no templates (they carry routing and activities), just a list of devices. */
  monitoredOnly?: boolean;
  onCreated: () => void;
}) {
  const trpc = useTRPC();
  const templates = useQuery(trpc.template.list.queryOptions({ orgId }));
  const init = useMutation(trpc.draft.init.mutationOptions({ onSuccess: onCreated }));

  const start = (templateId?: string) => init.mutate({ orgId, roomId, templateId });
  const starters = templates.data?.starters.filter((t) => t.roomType === roomType) ?? [];
  const own = templates.data?.org.filter((t) => t.roomType === roomType) ?? [];

  if (monitoredOnly)
    return (
      <div className="space-y-4">
        <MonitoredNotice />
        <div>
          <h2 className="text-lg font-medium">Add the devices to watch</h2>
          <p className="text-sm text-muted-foreground">
            Start with an empty list, then add each device and its address.
          </p>
        </div>
        {init.error && <p className="text-sm text-destructive">{init.error.message}</p>}
        <button className={btnCls} disabled={init.isPending} onClick={() => start()}>
          Start with a list of devices
        </button>
      </div>
    );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">Start this room from…</h2>
        <p className="text-sm text-muted-foreground">
          Pick a starting point. You can change everything afterwards.
        </p>
      </div>
      {init.error && <p className="text-sm text-destructive">{init.error.message}</p>}
      <div className="space-y-2">
        {starters.map((t) => (
          <div
            key={t.id}
            className="flex items-center justify-between gap-4 rounded-lg border border-border p-3"
          >
            <div>
              <div className="font-medium">{t.name}</div>
              <div className="text-sm text-muted-foreground">{t.description}</div>
            </div>
            <button className={btnCls} disabled={init.isPending} onClick={() => start(t.id)}>
              Use
            </button>
          </div>
        ))}
        {own.length > 0 && (
          <h3 className="pt-2 text-sm font-medium text-foreground/80">
            Your organisation&apos;s templates
          </h3>
        )}
        {own.map((t) => (
          <div
            key={t.id}
            className="flex items-center justify-between gap-4 rounded-lg border border-border p-3"
          >
            <div>
              <div className="font-medium">{t.name}</div>
              {t.description && (
                <div className="text-sm text-muted-foreground">{t.description}</div>
              )}
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
