'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useTRPC } from '@/trpc/client';
import type { DeviceRow } from './assets';

/** What a register still needs: the fields people are asked to keep complete. */
export const GAPS = [
  { key: 'serial', label: 'Serial', missing: (d: GapDevice) => !d.serial },
  { key: 'assetTag', label: 'Asset tag', missing: (d: GapDevice) => !d.assetTag },
  { key: 'makeModel', label: 'Make/model', missing: (d: GapDevice) => !d.make || !d.model },
  { key: 'installedOn', label: 'Install date', missing: (d: GapDevice) => !d.installedOn },
  { key: 'warrantyEndsOn', label: 'Warranty end', missing: (d: GapDevice) => !d.warrantyEndsOn },
  { key: 'endOfLifeOn', label: 'End of life', missing: (d: GapDevice) => !d.endOfLifeOn },
] as const;
export type GapKey = (typeof GAPS)[number]['key'];
export type GapDevice = Pick<
  DeviceRow,
  'serial' | 'assetTag' | 'make' | 'model' | 'installedOn' | 'warrantyEndsOn' | 'endOfLifeOn'
>;

export const gapKeysOf = (d: GapDevice): GapKey[] =>
  GAPS.filter((g) => g.missing(d)).map((g) => g.key);

const dayOf = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

/**
 * Fills in what one device is missing without leaving the register. "Save and next" moves on to
 * the next device with gaps in the list being viewed.
 */
export function FixGapsDialog({
  device,
  nextName,
  onSaved,
  onClose,
}: {
  device: DeviceRow;
  nextName: string | null;
  /** Called after a save; `next` is true for "Save and next". */
  onSaved: (next: boolean) => void;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  // The fields shown are the ones missing when the dialog opened, so they stay put while typing.
  const [gaps] = useState(() => new Set(gapKeysOf(device)));
  const [v, setV] = useState({
    serial: device.serial ?? '',
    assetTag: device.assetTag ?? '',
    make: device.make ?? '',
    model: device.model ?? '',
    installedOn: dayOf(device.installedOn),
    warrantyEndsOn: dayOf(device.warrantyEndsOn),
    endOfLifeOn: dayOf(device.endOfLifeOn),
  });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setV({ ...v, [k]: e.target.value });

  const save = useMutation(
    trpc.device.update.mutationOptions({
      onError: (e) => toast.error(e.message),
    }),
  );

  async function submit(next: boolean) {
    const patch: Record<string, unknown> = {};
    for (const k of ['serial', 'assetTag', 'make', 'model'] as const)
      if (v[k].trim() && v[k].trim() !== (device[k] ?? '')) patch[k] = v[k].trim();
    for (const k of ['installedOn', 'warrantyEndsOn', 'endOfLifeOn'] as const)
      if (v[k] && v[k] !== dayOf(device[k])) patch[k] = new Date(v[k]);
    if (Object.keys(patch).length === 0) {
      onSaved(next);
      return;
    }
    try {
      await save.mutateAsync({ orgId, deviceId: device.id, ...patch });
    } catch {
      return;
    }
    toast.success(`Saved ${device.name}`);
    await qc.invalidateQueries({ queryKey: trpc.device.list.queryKey() });
    onSaved(next);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Complete {device.name}</DialogTitle>
          <DialogDescription>
            Only what is missing is shown. Leave a field blank to skip it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          {gaps.has('serial') && (
            <Field label="Serial number">
              <Input value={v.serial} onChange={set('serial')} maxLength={100} />
            </Field>
          )}
          {gaps.has('assetTag') && (
            <Field label="Asset tag">
              <Input value={v.assetTag} onChange={set('assetTag')} maxLength={80} />
            </Field>
          )}
          {gaps.has('makeModel') && (
            <>
              <Field label="Make">
                <Input value={v.make} onChange={set('make')} maxLength={100} />
              </Field>
              <Field label="Model">
                <Input value={v.model} onChange={set('model')} maxLength={100} />
              </Field>
            </>
          )}
          {gaps.has('installedOn') && (
            <Field label="Installed">
              <Input type="date" value={v.installedOn} onChange={set('installedOn')} />
            </Field>
          )}
          {gaps.has('warrantyEndsOn') && (
            <Field label="Warranty ends">
              <Input type="date" value={v.warrantyEndsOn} onChange={set('warrantyEndsOn')} />
            </Field>
          )}
          {gaps.has('endOfLifeOn') && (
            <Field label="End of life">
              <Input type="date" value={v.endOfLifeOn} onChange={set('endOfLifeOn')} />
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={nextName ? 'outline' : 'default'}
            disabled={save.isPending}
            onClick={() => void submit(false)}
          >
            Save
          </Button>
          {nextName && (
            <Button disabled={save.isPending} onClick={() => void submit(true)}>
              Save and next
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Sets install, warranty-end and end-of-life dates for a whole room, site or organisation at once.
 * Blanks only, unless told to replace dates already recorded.
 */
export function AlignDatesDialog({
  sites,
  rooms,
  onClose,
}: {
  sites: { id: string; name: string }[];
  rooms: { id: string; name: string; siteId: string }[];
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const [scope, setScope] = useState<'org' | 'site' | 'room'>('site');
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '');
  const [roomId, setRoomId] = useState('');
  const [installedOn, setInstalledOn] = useState('');
  const [warrantyEndsOn, setWarrantyEndsOn] = useState('');
  const [endOfLifeOn, setEndOfLifeOn] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const siteRooms = rooms.filter((r) => r.siteId === siteId);
  const scopeId = scope === 'org' ? null : scope === 'site' ? siteId : roomId;
  const valid = (installedOn || warrantyEndsOn || endOfLifeOn) && (scope === 'org' || !!scopeId);

  const align = useMutation(
    trpc.device.alignDates.mutationOptions({
      onSuccess: async (r) => {
        toast.success(
          r.updated === 0
            ? `Nothing to change across ${r.matched} devices`
            : `Updated ${r.updated} of ${r.matched} devices`,
        );
        await qc.invalidateQueries({ queryKey: trpc.device.list.queryKey() });
        onClose();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Align dates</DialogTitle>
          <DialogDescription>
            Apply the same install, warranty end and end of life dates to every device in a room, a
            site or the whole organisation. Leave a date blank to leave that field alone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Apply to">
            <SimpleSelect
              value={scope}
              onValueChange={(s) => setScope(s as typeof scope)}
              options={[
                { value: 'room', label: 'A room' },
                { value: 'site', label: 'A site' },
                { value: 'org', label: 'The whole organisation' },
              ]}
            />
          </Field>
          {scope !== 'org' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Site">
                <SimpleSelect
                  value={siteId}
                  onValueChange={(s) => {
                    setSiteId(s);
                    setRoomId('');
                  }}
                  options={sites.map((s) => ({ value: s.id, label: s.name }))}
                />
              </Field>
              {scope === 'room' && (
                <Field label="Room">
                  <SimpleSelect
                    value={roomId}
                    placeholder="Choose a room"
                    onValueChange={setRoomId}
                    options={siteRooms.map((r) => ({ value: r.id, label: r.name }))}
                  />
                </Field>
              )}
            </div>
          )}
          <div className="grid grid-cols-3 gap-3">
            <Field label="Installed">
              <Input
                type="date"
                value={installedOn}
                onChange={(e) => setInstalledOn(e.target.value)}
              />
            </Field>
            <Field label="Warranty ends">
              <Input
                type="date"
                value={warrantyEndsOn}
                onChange={(e) => setWarrantyEndsOn(e.target.value)}
              />
            </Field>
            <Field label="End of life">
              <Input
                type="date"
                value={endOfLifeOn}
                onChange={(e) => setEndOfLifeOn(e.target.value)}
              />
            </Field>
          </div>
          <Label className="flex items-start gap-2 text-sm font-normal">
            <Checkbox
              checked={overwrite}
              onCheckedChange={(c) => setOverwrite(c === true)}
              className="mt-0.5"
            />
            <span>
              Replace dates already recorded
              <span className="block text-xs text-muted-foreground">
                Off: only devices with that date blank are filled in.
              </span>
            </span>
          </Label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid || align.isPending}
            onClick={() =>
              align.mutate({
                orgId,
                scope,
                scopeId,
                overwrite,
                ...(installedOn ? { installedOn: new Date(installedOn) } : {}),
                ...(warrantyEndsOn ? { warrantyEndsOn: new Date(warrantyEndsOn) } : {}),
                ...(endOfLifeOn ? { endOfLifeOn: new Date(endOfLifeOn) } : {}),
              })
            }
          >
            Apply dates
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
