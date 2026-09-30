'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Preview = RouterOutputs['register']['import'];

/** Reads an existing asset spreadsheet (CSV) into the register: a preview first, then apply. */
export function ImportRegisterDialog({
  sites,
  onClose,
}: {
  sites: { id: string; name: string }[];
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const run = useMutation(
    trpc.register.import.mutationOptions({
      onError: (e) => toast.error(e.message),
    }),
  );
  const check = async () => setPreview(await run.mutateAsync({ orgId, siteId, csv, dryRun: true }));
  const apply = async () => {
    const r = await run.mutateAsync({ orgId, siteId, csv, dryRun: false });
    if (r.errors.length === 0) {
      toast.success(`Imported: ${r.created} added, ${r.updated} updated`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: trpc.device.list.queryKey() }),
        qc.invalidateQueries({ queryKey: trpc.monitoring.estate.queryKey() }),
      ]);
      onClose();
    } else setPreview(r);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import from a spreadsheet</DialogTitle>
          <DialogDescription>
            Save the sheet as CSV. Columns it understands: Name (required), Type or Category, Room,
            Make, Model, Serial number, MAC, IP, Firmware, Asset tag, Status, Installed, Warranty
            ends, End of life, Supplier, Notes. Devices are matched by asset tag, then serial, then
            name. Blank cells never clear anything.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <SimpleSelect
              size="sm"
              className="w-44"
              value={siteId}
              onValueChange={(v) => {
                setSiteId(v);
                setPreview(null);
              }}
              options={sites.map((s) => ({ value: s.id, label: s.name }))}
            />
            <input
              type="file"
              accept=".csv,text/csv"
              aria-label="Choose a CSV file"
              className="text-sm"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setFileName(f.name);
                setCsv(await f.text());
                setPreview(null);
              }}
            />
          </div>
          {preview && (
            <div className="space-y-2 text-sm">
              <div>
                {preview.created} to add, {preview.updated} to update, {preview.skipped} unchanged.
              </div>
              {preview.errors.map((e, i) => (
                <div key={i} className="text-destructive">
                  {e}
                </div>
              ))}
              <ul className="max-h-56 divide-y overflow-y-auto rounded-md border">
                {preview.lines.map((l) => (
                  <li key={l.line} className="px-3 py-1.5 text-xs">
                    <span className="mr-2 text-muted-foreground">Line {l.line}</span>
                    <span className="font-medium">{l.name || '(no name)'}</span>
                    <Badge variant={l.action === 'skip' ? 'outline' : 'secondary'} className="ml-2">
                      {l.action === 'create'
                        ? 'add'
                        : l.action === 'update'
                          ? `update by ${l.matchedBy}`
                          : 'no change'}
                    </Badge>
                    {l.warnings.map((w, i) => (
                      <div key={i} className="text-warning">
                        {w}
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="outline"
            disabled={!csv || !siteId || run.isPending}
            onClick={() => void check()}
          >
            {fileName ? 'Preview' : 'Choose a file first'}
          </Button>
          <Button
            disabled={!preview || preview.errors.length > 0 || run.isPending}
            onClick={() => void apply()}
          >
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
