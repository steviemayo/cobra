import { signAccess } from '@kestrel/crypto';
import type { AssignedRoom } from '@kestrel/model';
import type { Store } from './store';

const keyFor = (roomId: string) => `phone:${roomId}`;

/** How long a QR link works. The panel swaps in a fresh one before then, so a photo of it goes stale. */
export const JOIN_TTL_SECONDS = 10 * 60;

/** Signs the links on a room's QR code with the secret the cloud gave this gateway for that room. */
export class PhoneLinks {
  constructor(
    private readonly store: Store,
    private readonly cloudUrl: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Remembers each room's secret (so QR codes work offline too) and forgets rooms that are gone. */
  setSecrets(rooms: AssignedRoom[]) {
    const keep = new Set<string>();
    for (const r of rooms) {
      if (!r.phoneSecret) continue;
      keep.add(keyFor(r.roomId));
      if (this.store.get(keyFor(r.roomId)) !== r.phoneSecret) this.store.set(keyFor(r.roomId), r.phoneSecret);
    }
    for (const k of this.store.keysWithPrefix('phone:')) if (!keep.has(k)) this.store.delete(k);
  }

  /** A link for this room, or null if the cloud has not given us a secret for it. */
  link(roomId: string): { url: string; expiresAt: string } | null {
    const secret = this.store.get(keyFor(roomId));
    if (!secret) return null;
    const exp = Math.floor(this.now() / 1000) + JOIN_TTL_SECONDS;
    return {
      url: `${this.cloudUrl}/c/${signAccess(secret, 'join', roomId, exp)}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }
}
