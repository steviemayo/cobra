'use client';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { downloadFile } from '@/lib/download';
import { printHtml, visitsToCsv, visitsToHtml } from '@/lib/pm-export';
import { useTRPC } from '@/trpc/client';

/** Export of maintenance visits: a spreadsheet (CSV), or a printable page to save as a PDF. */
export function PmExportMenu({
  filter,
  name,
  title,
  subtitle,
  disabled,
}: {
  filter: {
    runId?: string;
    roomId?: string;
    deviceId?: string;
    status?: 'draft' | 'signed';
    failedOnly?: boolean;
  };
  /** Start of the file name. */
  name: string;
  title: string;
  subtitle?: string;
  disabled?: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const [busy, setBusy] = useState(false);

  async function run(kind: 'csv' | 'pdf') {
    setBusy(true);
    try {
      const visits = await qc.fetchQuery({
        ...trpc.pm.exportRuns.queryOptions({ orgId, ...filter }),
        staleTime: 0,
      });
      if (visits.length === 0) {
        toast.error('There is nothing to export');
        return;
      }
      if (kind === 'csv')
        downloadFile({
          filename: `${name}-${new Date().toISOString().slice(0, 10)}.csv`,
          contentType: 'text/csv',
          body: visitsToCsv(visits),
        });
      else printHtml(visitsToHtml(visits, { title, subtitle }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not export');
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size="sm" variant="outline" disabled={disabled || busy} />}
      >
        <Download data-icon="inline-start" /> Export
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void run('csv')}>
          <FileSpreadsheet className="size-4" /> CSV (one row per room)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void run('pdf')}>
          <FileText className="size-4" /> PDF (print or save)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
