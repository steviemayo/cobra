import type { PrismaClient } from '@kestrel/db';
import { annotateFound, parseDiscoveryOutput, type AnnotatedHost } from './discovery';
import { inScope, siteFilter, type SiteScope } from './site-scope';

export type DiscoveryDb = Pick<PrismaClient, 'remoteCommand' | 'gateway' | 'device'>;

export interface DiscoveryResultView {
  status: string;
  /** What the gateway (or the portal) said went wrong, as written. Shown as plain text. */
  error: string | null;
  gatewayId: string;
  siteId: string;
  subnets: string[];
  hostsScanned: number;
  truncated: boolean;
  found: AnnotatedHost[];
}

/**
 * What a scan found, matched against the register. Null when there is no such scan in this
 * organisation (or on a gateway the caller's site scope cannot see). The gateway's answer is read
 * defensively: it is a hint for a person to check, never trusted input.
 */
export async function discoveryResult(
  db: DiscoveryDb,
  input: { orgId: string; commandId: string; siteScope: SiteScope },
): Promise<DiscoveryResultView | null> {
  const cmd = await db.remoteCommand.findFirst({
    where: { id: input.commandId, orgId: input.orgId, type: 'discover_devices' },
  });
  if (!cmd) return null;
  const gateway = await db.gateway.findFirst({ where: { id: cmd.gatewayId, orgId: input.orgId } });
  if (!gateway || !inScope(input.siteScope, gateway.siteId)) return null;

  const base = {
    status: cmd.status,
    error: cmd.error ?? null,
    gatewayId: gateway.id,
    siteId: gateway.siteId,
  };
  if (cmd.status !== 'succeeded')
    return { ...base, subnets: [], hostsScanned: 0, truncated: false, found: [] };

  const report = parseDiscoveryOutput(cmd.output);
  const register = await db.device.findMany({
    where: { orgId: input.orgId, ...siteFilter(input.siteScope) },
    select: { id: true, name: true, ip: true, values: true },
  });
  return {
    ...base,
    subnets: report.subnets,
    hostsScanned: report.hostsScanned,
    truncated: report.truncated,
    found: annotateFound(report.found, register),
  };
}
