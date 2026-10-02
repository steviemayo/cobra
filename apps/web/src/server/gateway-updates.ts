// Gateways follow a release channel, separately from room programs. The portal records which channel
// a gateway follows and whether it is behind, and asks a gateway to update by putting an order in
// its heartbeat reply once someone has requested it (or its policy is Automatic). The gateway does
// the work; it never accepts an inbound connection.
import { channelRelease } from './gateway-release';

export type Channel = 'stable' | 'beta';

/**
 * The newest version on each channel: what is actually published, read from the release's VERSION
 * file on GitHub and cached briefly. That file is the only source: CI writes it when a gateway change
 * reaches `main` (stable) or `dev` (beta), so nothing is set by hand on the server. A channel whose
 * release cannot be read is null (the gateway's update status is then "unknown").
 */
export async function publishedVersions(
  read: (channel: Channel) => Promise<string | null> = async (c) =>
    (await channelRelease(c))?.version ?? null,
): Promise<Record<Channel, string | null>> {
  const [stable, beta] = await Promise.all([
    read('stable').catch(() => null),
    read('beta').catch(() => null),
  ]);
  return { stable, beta };
}

function parts(v: string): number[] {
  const core = v.trim().replace(/^v/, '').split(/[-+]/)[0] ?? '';
  return core.split('.').map((n) => Number.parseInt(n, 10) || 0);
}

/** Negative if a is older than b, positive if newer, 0 if the same (missing parts count as 0). */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export type UpdateStatus = 'current' | 'behind' | 'unknown';

/** Whether a gateway is running the newest version on its channel; unknown if either is not known. */
export function updateStatus(
  gateway: { version: string | null; channel: Channel },
  latest: Record<Channel, string | null>,
): { status: UpdateStatus; latest: string | null } {
  const newest = latest[gateway.channel];
  if (!gateway.version || !newest) return { status: 'unknown', latest: newest };
  return {
    status: compareVersions(gateway.version, newest) < 0 ? 'behind' : 'current',
    latest: newest,
  };
}

// ---- Asking a gateway to update ----------------------------------------------------------------

/** A gateway that stops reporting mid-update for this long is treated as having failed. */
export const UPDATE_STALE_MS = 15 * 60_000;
const IN_PROGRESS = ['downloading', 'staged', 'applying'];

/** Only a gateway that says it can update itself is ever sent an order (an older one fails to read it). */
export const canSelfUpdate = (features: string[] | null | undefined) =>
  !!features?.includes('self-update');

export interface UpdateInputs {
  /** The version this heartbeat reported. */
  reportedVersion: string;
  features: string[];
  autoUpdate: boolean;
  request: {
    notBefore: Date | null;
    version: string | null;
    state: string | null;
    reportedAt: Date | null;
  };
  /** What is published on the gateway's channel now, when the portal could read it. */
  release: { version: string | null } | null;
  now: Date;
}

export type UpdateAction =
  | { kind: 'none' }
  /** Done, or nothing left to do: forget the request. */
  | { kind: 'clear' }
  /** The Automatic policy asks for the update itself. */
  | { kind: 'request'; version: string; notBefore: Date }
  | { kind: 'fail'; error: string }
  | { kind: 'order'; version: string };

/** What a heartbeat should do about updates. Pure, so the rules can be tested without a database. */
export function planUpdate(i: UpdateInputs): UpdateAction {
  const can = canSelfUpdate(i.features);
  const { request } = i;
  if (request.version && compareVersions(i.reportedVersion, request.version) >= 0)
    return { kind: 'clear' };

  if (!request.notBefore) {
    const newest = i.release?.version;
    if (i.autoUpdate && can && newest && compareVersions(i.reportedVersion, newest) < 0)
      return { kind: 'request', version: newest, notBefore: i.now };
    return { kind: 'none' };
  }

  if (!can || request.notBefore.getTime() > i.now.getTime()) return { kind: 'none' };
  // A failure stays visible until someone retries or cancels; it is not retried in a loop.
  if (request.state === 'failed' || request.state === 'unsupported') return { kind: 'none' };
  if (
    IN_PROGRESS.includes(request.state ?? '') &&
    request.reportedAt &&
    i.now.getTime() - request.reportedAt.getTime() > UPDATE_STALE_MS
  )
    return { kind: 'fail', error: 'The update did not finish. Try again.' };

  const newest = i.release?.version;
  if (!newest) return { kind: 'none' };
  if (compareVersions(i.reportedVersion, newest) >= 0) return { kind: 'clear' };
  return { kind: 'order', version: newest };
}
