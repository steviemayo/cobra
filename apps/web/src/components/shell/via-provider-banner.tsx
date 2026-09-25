'use client';
import Link from 'next/link';
import { Handshake } from 'lucide-react';
import { orgPath, useOrg } from './org-context';

/**
 * Shown while working in a customer through a service provider, so it is always clear whose
 * organisation this is and under which connection you are here.
 */
export function ViaProviderBanner() {
  const { org, orgs } = useOrg();
  if (!org.via) return null;
  const home = orgs.find((o) => o.kind === 'msp');
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/60 px-3 py-1.5 text-sm"
    >
      <Handshake className="size-4 text-muted-foreground" />
      <span>
        You are working in <span className="font-medium">{org.name}</span> as {org.via}.
      </span>
      {home && (
        <Link
          href={orgPath(home.id, '/msp')}
          className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          Back to all customers
        </Link>
      )}
    </div>
  );
}
