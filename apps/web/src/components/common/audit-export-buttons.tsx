'use client';
import { useMutation } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { downloadFile } from '@/lib/download';

interface ExportFile {
  filename: string;
  contentType: string;
  body: string;
  count: number;
  truncated: boolean;
}

/** Download buttons for an activity log. `run` builds the file on the server (owner or staff version). */
export function AuditExportButtons({
  run,
  pending,
}: {
  run: (format: 'csv' | 'json') => Promise<ExportFile>;
  pending?: boolean;
}) {
  const download = useMutation({
    mutationFn: run,
    onSuccess: (file) => {
      downloadFile(file);
      toast.success(
        file.truncated
          ? `Downloaded the first ${file.count.toLocaleString()} rows. Choose a shorter period for the rest.`
          : `Downloaded ${file.count.toLocaleString()} rows`,
      );
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <div className="flex items-center gap-2">
      {(['csv', 'json'] as const).map((format) => (
        <Button
          key={format}
          size="sm"
          variant="outline"
          disabled={download.isPending || pending}
          onClick={() => download.mutate(format)}
        >
          {download.isPending && download.variables === format ? (
            <Spinner />
          ) : (
            <Download data-icon="inline-start" />
          )}
          {format.toUpperCase()}
        </Button>
      ))}
    </div>
  );
}
