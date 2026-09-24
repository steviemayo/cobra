// Gateways update themselves from their own release channel (a container tag that Watchtower or the
// Windows service follows), separately from room programs. The cloud does not push an update; it
// records which channel a gateway follows and tells the portal whether it is behind.
export type Channel = 'stable' | 'beta';

/** The newest version published on each channel, set by whoever releases the gateway. */
export function latestVersions(env: Record<string, string | undefined> = process.env): Record<Channel, string | null> {
  const clean = (v: string | undefined) => (v && /^\d+(\.\d+){0,2}/.test(v.trim()) ? v.trim() : null);
  return { stable: clean(env.GATEWAY_LATEST_STABLE), beta: clean(env.GATEWAY_LATEST_BETA) };
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
  latest: Record<Channel, string | null> = latestVersions(),
): { status: UpdateStatus; latest: string | null } {
  const newest = latest[gateway.channel];
  if (!gateway.version || !newest) return { status: 'unknown', latest: newest };
  return { status: compareVersions(gateway.version, newest) < 0 ? 'behind' : 'current', latest: newest };
}
