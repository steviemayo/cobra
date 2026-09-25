'use client';
import { createContext, useContext, useEffect, useMemo } from 'react';
import type { OrgRole } from '@kestrel/model';
import { rememberOrg } from '@/lib/last-org';

export interface OrgSummary {
  id: string;
  name: string;
  role: OrgRole;
  /** msp: a managed service provider rather than a customer. */
  kind?: string;
  /** Set when you reach this organisation through a service provider: its name. */
  via?: string;
  /** You reach this organisation through a provider connection limited to specific sites. */
  scoped?: boolean;
}

interface OrgContextValue {
  orgId: string;
  org: OrgSummary;
  orgs: OrgSummary[];
  role: OrgRole;
  user: { id: string; email: string };
  /** Owners and developers can create and edit estate and designs. */
  canEdit: boolean;
  isOwner: boolean;
  /** Owners, developers and support can see team and activity. */
  canSeeTeam: boolean;
  /** Owners, developers and support can work incidents, tickets and remote tools. */
  canSupport: boolean;
}

const OrgContext = createContext<OrgContextValue | null>(null);

export function OrgProvider({
  orgId,
  orgs,
  user,
  children,
}: {
  orgId: string;
  orgs: OrgSummary[];
  user: { id: string; email: string };
  children: React.ReactNode;
}) {
  const value = useMemo<OrgContextValue>(() => {
    const org = orgs.find((o) => o.id === orgId)!;
    return {
      orgId,
      org,
      orgs,
      role: org.role,
      user,
      canEdit: org.role === 'owner' || org.role === 'dev',
      isOwner: org.role === 'owner',
      canSeeTeam: org.role !== 'customer_viewer',
      canSupport: org.role !== 'customer_viewer',
    };
  }, [orgId, orgs, user]);

  useEffect(() => rememberOrg(orgId), [orgId]);

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgContextValue {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrg must be used inside OrgProvider');
  return ctx;
}

export function orgPath(orgId: string, path = '') {
  return `/o/${orgId}${path}`;
}
