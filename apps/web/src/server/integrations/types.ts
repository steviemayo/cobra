import type { z } from 'zod';

// Integrations pull device state from a vendor's cloud, so a room can be monitored with no gateway.
// A provider knows how to sign in and list what the vendor can see; the sync engine (sync.ts)
// turns that into Kestrel devices, history and incidents, the same for every provider.

/** One device or room system as the vendor describes it, already in Kestrel's words. */
export interface ExternalDevice {
  /** The vendor's own id. Stable: the pairing key. */
  externalId: string;
  name: string;
  /** The vendor's room or space name, used to match or create a Kestrel room. */
  roomName?: string | null;
  category: string;
  make?: string | null;
  model?: string | null;
  serial?: string | null;
  mac?: string | null;
  ip?: string | null;
  firmware?: string | null;
  /** null: the vendor cannot say (shown as unknown, not offline). */
  online: boolean | null;
  /** Fields of DeviceFeedback (inMeeting, roomState, occupied, ...). */
  feedback?: Record<string, string | number | boolean>;
  /** Faults in plain words. Each open one keeps a room_fault incident open. */
  issues?: string[];
}

export interface ProviderDeps {
  fetch: typeof fetch;
  now: () => number;
}

export interface Provider<C = Record<string, unknown>> {
  id: string;
  label: string;
  /** The credentials a customer pastes in. Everything in it is sealed. */
  credentials: z.ZodType<C>;
  /** Signs in and reads once. Throws a plain-language Error when it cannot. */
  test(creds: C, deps: ProviderDeps): Promise<void>;
  /** Everything the vendor can see for this customer. */
  list(creds: C, deps: ProviderDeps): Promise<ExternalDevice[]>;
}

export const realProviderDeps = (): ProviderDeps => ({
  fetch: (input, init) =>
    fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) }),
  now: () => Date.now(),
});

/** Reads a JSON answer, turning a refusal into words a customer can act on. */
export async function readJson(res: Response, what: string): Promise<unknown> {
  if (res.status === 401 || res.status === 403)
    throw new Error(
      `${what} refused the credentials. Check they are correct and have the access listed in the setup guide`,
    );
  if (res.status === 429)
    throw new Error(`${what} says we are asking too often. It will be retried`);
  if (!res.ok) throw new Error(`${what} answered HTTP ${res.status}`);
  return res.json();
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;
