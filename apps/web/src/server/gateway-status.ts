export const HEARTBEAT_SECONDS = 30;
/** A gateway that has missed three heartbeats is offline. */
export const OFFLINE_AFTER_MS = HEARTBEAT_SECONDS * 3 * 1000;

export function effectiveStatus(
  gw: { enrolledAt: Date | null; lastSeenAt: Date | null },
  now = Date.now(),
): 'pending' | 'online' | 'offline' {
  if (!gw.enrolledAt) return 'pending';
  if (!gw.lastSeenAt || now - gw.lastSeenAt.getTime() > OFFLINE_AFTER_MS) return 'offline';
  return 'online';
}
