'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useTRPC } from '@/trpc/client';

/**
 * Camera previews. A picture from a camera can show people, so it is off until an owner turns it on.
 * With it on, owners, developers and support can ask a monitored camera for one still picture from
 * its device page. The picture is shown once and not saved; each request is recorded in the audit trail.
 */
export function CameraPreviewSetting() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, isOwner } = useOrg();
  const state = useQuery(trpc.org.getCameraPreview.queryOptions({ orgId }));
  const on = state.data?.on ?? false;

  const save = useMutation(
    trpc.org.setCameraPreview.mutationOptions({
      onSuccess: async (res) => {
        await Promise.all([
          qc.invalidateQueries({ queryKey: trpc.org.getCameraPreview.queryKey({ orgId }) }),
          qc.invalidateQueries({ queryKey: trpc.device.previewEnabled.queryKey({ orgId }) }),
          qc.invalidateQueries({ queryKey: trpc.audit.list.queryKey() }),
        ]);
        toast.success(res.on ? 'Camera previews are on.' : 'Camera previews are off.');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <section className="space-y-4 border-t pt-6">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-medium">
          Camera previews{' '}
          {state.data && <Badge variant={on ? 'default' : 'secondary'}>{on ? 'On' : 'Off'}</Badge>}
        </h2>
        <p className="text-sm text-muted-foreground">
          Let owners, developers and support ask a monitored camera for a single picture from its
          device page, to check what it sees. The picture is shown once and not saved, and each
          request is recorded in the audit trail. It can show people, so it is off until you turn
          it on.
        </p>
      </div>
      {isOwner ? (
        <label className="flex items-start gap-3 rounded-lg border p-4 text-sm">
          <Switch
            checked={on}
            disabled={state.isPending || save.isPending}
            onCheckedChange={(next) => save.mutate({ orgId, on: !!next })}
          />
          <span>
            Allow camera previews
            <span className="block text-muted-foreground">
              Only for cameras on a driver that can give a picture (for example Generic ONVIF) and
              a gateway that is up to date.
            </span>
          </span>
        </label>
      ) : (
        <p className="text-sm text-muted-foreground">Only an owner can change this.</p>
      )}
    </section>
  );
}
