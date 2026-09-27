'use client';
import Link from 'next/link';
import { Eye } from 'lucide-react';
import { orgPath, useOrg } from '@/components/shell/org-context';

/** Says what a room without control can do, and where to get the rest. */
export function MonitoredNotice() {
  const { orgId, isOwner } = useOrg();
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-3 text-sm">
      <Eye className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <p className="text-muted-foreground">
        This room is monitored only. Add its devices and their addresses and Kestrel watches them
        and alerts you. Routing, activities, triggers and the touch panel come with Pro.{' '}
        {isOwner ? (
          <Link
            href={orgPath(orgId, '/settings/billing')}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            See plans
          </Link>
        ) : (
          'Ask an owner to upgrade.'
        )}
      </p>
    </div>
  );
}
