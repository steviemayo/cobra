'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  DEVICE_CATALOG,
  USAGE_KIND_LABEL,
  assetCategoryLabel,
  describeUsageRule,
  type DeviceCategory,
  type UsageKind,
  type UsageRule,
} from '@kestrel/model';
import { UsageRuleEditor, type RuleDeviceOption } from '@/components/common/usage-rule-editor';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/trpc/client';

const SOURCE_TEXT = {
  room: "This room's own rule.",
  org: "The organisation's rule, used by every room without its own.",
  default: "Kestrel's usual rule, used until someone sets one.",
} as const;

/**
 * Edits what counts as "in use" for one room, or (roomId null) for the whole organisation. Saving a
 * rule recomputes past sessions too, since they are worked out from the stored readings each time.
 */
export function UsageDefinitionDialog({
  roomId,
  roomName,
  kind,
  devices,
  onClose,
}: {
  roomId: string | null;
  roomName?: string;
  kind: UsageKind;
  devices: RuleDeviceOption[];
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport } = useOrg();
  const def = useQuery(trpc.roomUsage.definition.queryOptions({ orgId, roomId, kind }));
  const [rule, setRule] = useState<UsageRule | null>(null);
  const [holdOff, setHoldOff] = useState(180);
  const [minOn, setMinOn] = useState(60);
  useEffect(() => {
    if (def.data && rule === null) {
      setRule(def.data.rule);
      setHoldOff(def.data.holdOffSeconds);
      setMinOn(def.data.minOnSeconds);
    }
  }, [def.data, rule]);

  const done = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: trpc.roomUsage.room.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.roomUsage.estate.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.roomUsage.definition.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.monitoring.estate.queryKey() }),
    ]);
    onClose();
  };
  const save = useMutation(
    trpc.roomUsage.saveDefinition.mutationOptions({
      onSuccess: async () => {
        toast.success('Saved. Past use is recalculated with the new rule.');
        await done();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const reset = useMutation(
    trpc.roomUsage.resetDefinition.mutationOptions({
      onSuccess: async () => {
        toast.success(
          roomId ? 'This room now follows the organisation rule' : 'Back to the usual rule',
        );
        await done();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const nameOf = (c: { deviceId?: string; category?: string }) =>
    c.deviceId
      ? (devices.find((d) => d.id === c.deviceId)?.name ?? 'a device')
      : `any ${DEVICE_CATALOG[c.category as DeviceCategory]?.label.toLowerCase() ?? assetCategoryLabel(c.category ?? '')}`;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {USAGE_KIND_LABEL[kind]}: {roomId ? (roomName ?? 'this room') : 'all rooms'}
          </DialogTitle>
          <DialogDescription>
            Say what a room looks like when it is {kind === 'av' ? 'being used' : 'occupied'}. A
            reading from any device can count, for example a display that is on, or someone
            detected.
          </DialogDescription>
        </DialogHeader>
        {def.isError ? (
          <p className="text-destructive text-sm">Could not load the rule: {def.error.message}</p>
        ) : def.isPending || rule === null ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              {def.data ? SOURCE_TEXT[def.data.source] : null}
            </p>
            <UsageRuleEditor value={rule} onChange={setRule} devices={devices} />
            <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              In words: {describeUsageRule(rule, nameOf)}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">
                  Keep a session going through gaps shorter than (seconds)
                </Label>
                <Input
                  type="number"
                  min={0}
                  max={3600}
                  value={holdOff}
                  onChange={(e) => setHoldOff(Number(e.target.value))}
                  className="h-8"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Ignore sessions shorter than (seconds)</Label>
                <Input
                  type="number"
                  min={0}
                  max={3600}
                  value={minOn}
                  onChange={(e) => setMinOn(Number(e.target.value))}
                  className="h-8"
                />
              </div>
            </div>
          </div>
        )}
        <DialogFooter className="sm:justify-between">
          <div>
            {canSupport && def.data?.hasOwn && (
              <Button
                variant="ghost"
                onClick={() => reset.mutate({ orgId, roomId, kind })}
                disabled={reset.isPending}
              >
                {roomId ? 'Use the organisation rule' : 'Back to the usual rule'}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {canSupport && (
              <Button
                disabled={rule === null || save.isPending}
                onClick={() =>
                  rule &&
                  save.mutate({
                    orgId,
                    roomId,
                    kind,
                    rule,
                    holdOffSeconds: holdOff,
                    minOnSeconds: minOn,
                  })
                }
              >
                Save rule
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
