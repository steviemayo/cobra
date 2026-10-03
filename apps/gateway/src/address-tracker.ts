import { lookup } from 'node:dns/promises';
import {
  ADDRESS_TRACKING_KEY,
  AddressTracking,
  normaliseMac,
  type DeviceAddressReport,
} from '@kestrel/model';
import { readArp, type ArpReader } from './arp';
import { isPrivateV4, ownSubnets, pjlinkInfo, tcpOpen } from './discovery';
import type { Logger } from './log';

// Devices whose address can change (a DHCP lease that moved). A device the portal marks *tracked* is
// found again when it goes quiet: first by its hostname, then by its MAC among what answers on its
// port on the gateway's own network, then by asking a projector its name. It adopts an address
// only when exactly one thing is identified as the device; anything less is left as a suggestion
// for a person. Nothing here sends a command to a device: it connects, and reads.

/** Quiet this long before looking: a reboot or a blip is not a new lease. */
export const LOST_AFTER_MS = 10_000;
/** After a failed search, wait this long, doubling each time up to the longest. */
export const RETRY_FIRST_MS = 30_000;
export const RETRY_LONGEST_MS = 15 * 60_000;
/** An online device's MAC is checked against what the network says about its address this often. */
export const VERIFY_EVERY_MS = 5 * 60_000;
/** How long a read of the ARP table is reused. */
const ARP_TTL_MS = 20_000;

export interface TrackedSpec {
  /** The address the cloud has for the device. After a move the gateway runs it somewhere else until the cloud catches up. */
  host: string;
  port?: number;
  tracking: AddressTracking;
  /** It speaks PJLink, so it can be asked its name. */
  pjlink?: boolean;
}

export type Recovery =
  | { kind: 'moved'; address: string; how: 'hostname' | 'mac' | 'identity' }
  | { kind: 'ambiguous'; candidates: { address: string; note: string }[] }
  | { kind: 'none' };

export interface AddressDeps {
  lookupHost: (name: string) => Promise<string | undefined>;
  arp: ArpReader;
  open: typeof tcpOpen;
  pjlink: typeof pjlinkInfo;
  subnets: () => { prefix: string; own: Set<string> }[];
  now: () => number;
}

export const realAddressDeps = (): AddressDeps => ({
  lookupHost: async (name) => {
    try {
      return (await lookup(name, { family: 4 })).address;
    } catch {
      return undefined;
    }
  },
  arp: readArp,
  open: tcpOpen,
  pjlink: pjlinkInfo,
  subnets: () => ownSubnets(),
  now: Date.now,
});

/** The tracking details in a device's settings, or undefined for a fixed device. */
export function trackingOf(settings: Record<string, unknown>): AddressTracking | undefined {
  const parsed = AddressTracking.safeParse(settings[ADDRESS_TRACKING_KEY]);
  return parsed.success ? parsed.data : undefined;
}

/** Settings with the address `from` replaced by `to` wherever it appears as host, address or ip. */
export function swapAddress(
  settings: Record<string, unknown>,
  from: string,
  to: string,
): Record<string, unknown> {
  const out = { ...settings };
  for (const k of ['host', 'address', 'ip']) if (out[k] === from) out[k] = to;
  return out;
}

const SCAN_CONCURRENCY = 64;
const MAX_CANDIDATES = 10;

async function openOnes(hosts: string[], port: number, deps: AddressDeps): Promise<string[]> {
  const found: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, hosts.length) }, async () => {
      while (next < hosts.length) {
        const h = hosts[next++]!;
        if (await deps.open(h, port, 300)) found.push(h);
      }
    }),
  );
  return found.sort();
}

/**
 * Looks for a device that has gone quiet. `claimed` is every address another device is using, so one
 * device is never mistaken for another. Makes connections and reads; changes nothing.
 */
export async function recoverAddress(
  spec: TrackedSpec,
  claimed: ReadonlySet<string>,
  deps: AddressDeps,
): Promise<Recovery> {
  const { host, port, tracking } = spec;
  const usable = (ip: string | undefined): ip is string =>
    !!ip && ip !== host && !claimed.has(ip) && isPrivateV4(ip);
  const answers = async (ip: string) => (port ? deps.open(ip, port, 800) : true);

  // 1. Its name. A DNS or mDNS answer is the network saying where the device is now.
  if (tracking.hostname) {
    const ip = await deps.lookupHost(tracking.hostname);
    if (usable(ip) && (await answers(ip))) return { kind: 'moved', address: ip, how: 'hostname' };
  }

  const mac = normaliseMac(tracking.mac);
  // 2. Its MAC, if the gateway has already seen it at another address.
  if (mac) {
    for (const [ip, m] of await deps.arp())
      if (m === mac && usable(ip) && (await answers(ip)))
        return { kind: 'moved', address: ip, how: 'mac' };
  }

  // 3. Ask what answers on its port, on the network it was on. Needs the gateway to be on that network.
  if (!port) return { kind: 'none' };
  const prefix = host.split('.').slice(0, 3).join('.');
  const net = deps.subnets().find((s) => s.prefix === prefix);
  if (!net || !isPrivateV4(host)) return { kind: 'none' };
  const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`).filter(
    (h) => h !== host && !net.own.has(h) && !claimed.has(h),
  );
  const open = await openOnes(hosts, port, deps);
  if (open.length === 0) return { kind: 'none' };
  // Connecting makes the network answer for each of them, so read the table again.
  const table = await deps.arp();
  if (mac) {
    const hit = open.filter((ip) => table.get(ip) === mac);
    if (hit.length === 1) return { kind: 'moved', address: hit[0]!, how: 'mac' };
    // Its MAC is known and nothing answering has it: none of these is the device.
    if (hit.length === 0) return { kind: 'none' };
  }
  if (spec.pjlink && tracking.name) {
    const same: string[] = [];
    for (const ip of open.slice(0, MAX_CANDIDATES * 2)) {
      const info = await deps.pjlink(ip, port, 1_200);
      if (info.name && info.name.trim().toLowerCase() === tracking.name.trim().toLowerCase())
        same.push(ip);
    }
    if (same.length === 1) return { kind: 'moved', address: same[0]!, how: 'identity' };
  }
  return {
    kind: 'ambiguous',
    candidates: open.slice(0, MAX_CANDIDATES).map((address) => ({
      address,
      note: mac
        ? 'Answers on the same port; its MAC could not be matched'
        : 'Answers on the same port; nothing identifies it as this device',
    })),
  };
}

interface State {
  spec: TrackedSpec;
  /** When the device was first seen quiet in this stretch, or null while it answers. */
  quietSince: number | null;
  nextTryAt: number;
  tries: number;
  lastVerifyAt: number;
  refindAt: string | undefined;
  /** The gateway found the device at a new address and is saying so until the cloud's set carries it. */
  moved: { from: string; to: string; how: 'hostname' | 'mac' | 'identity' } | null;
  candidates: { address: string; note: string }[] | null;
  issue: 'identity_changed' | 'not_found' | null;
  /** The MAC the network shows for the device's address, learned while it is healthy. */
  learnedMac: string | undefined;
}

export class AddressWatch {
  private readonly states = new Map<string, State>();
  private running = false;
  private arpCache: { at: number; table: Map<string, string> } | null = null;

  constructor(
    private readonly log: Logger,
    private readonly deps: AddressDeps = realAddressDeps(),
    /** A device moved: rebuild it with its new address. */
    private readonly onMoved: (deviceId: string) => void = () => undefined,
  ) {}

  /** Starts (or keeps) watching a device. Called whenever a device set is applied. */
  track(deviceId: string, spec: TrackedSpec | undefined) {
    if (!spec) return void this.states.delete(deviceId);
    const cur = this.states.get(deviceId);
    if (!cur) {
      this.states.set(deviceId, {
        spec,
        quietSince: null,
        nextTryAt: 0,
        tries: 0,
        lastVerifyAt: 0,
        refindAt: spec.tracking.refindAt,
        moved: null,
        candidates: null,
        issue: null,
        learnedMac: undefined,
      });
      return;
    }
    // The cloud has caught up with a move: stop saying it.
    if (cur.moved && spec.host === cur.moved.to) cur.moved = null;
    cur.spec = spec;
    // "Find again" was pressed: look at once, without waiting out the back-off.
    if (spec.tracking.refindAt !== cur.refindAt) {
      cur.refindAt = spec.tracking.refindAt;
      cur.nextTryAt = 0;
      cur.tries = 0;
      cur.quietSince ??= this.deps.now() - LOST_AFTER_MS;
    }
  }

  untrack(deviceId: string) {
    this.states.delete(deviceId);
  }

  /** The address to run the device at now, if it has moved and the cloud has not caught up yet. */
  override(deviceId: string): { from: string; to: string } | null {
    const s = this.states.get(deviceId);
    return s?.moved ? { from: s.moved.from, to: s.moved.to } : null;
  }

  /** Something else answers at the device's address, so it is reported offline whatever its driver says. */
  identityChanged(deviceId: string): boolean {
    return this.states.get(deviceId)?.issue === 'identity_changed';
  }

  /** What to tell the cloud about a tracked device. Undefined for one that is not tracked or has nothing to say. */
  report(deviceId: string): DeviceAddressReport | undefined {
    const s = this.states.get(deviceId);
    if (!s) return undefined;
    const out: DeviceAddressReport = {
      ...(s.learnedMac && { mac: s.learnedMac }),
      ...(s.moved && { change: s.moved }),
      ...(!s.moved && s.candidates?.length && { candidates: s.candidates }),
      ...(!s.moved && s.issue && { issue: s.issue }),
    };
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private async table(): Promise<Map<string, string>> {
    const now = this.deps.now();
    if (this.arpCache && now - this.arpCache.at < ARP_TTL_MS) return this.arpCache.table;
    const table = await this.deps.arp();
    this.arpCache = { at: now, table };
    return table;
  }

  /**
   * One pass: notes which devices are quiet, learns the MAC of healthy ones, checks that a device
   * still answering is the one that was there, and looks for the ones that are lost. `isOnline`
   * says how each device looks right now; `claimed` is every address in use.
   */
  async tick(isOnline: (deviceId: string) => boolean, claimed: ReadonlySet<string>): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.deps.now();
      for (const [id, s] of this.states) {
        const online = isOnline(id) && s.issue !== 'identity_changed';
        if (online) {
          s.quietSince = null;
          s.tries = 0;
          s.candidates = null;
          if (s.issue === 'not_found') s.issue = null;
        }
        // A healthy device: learn its MAC, or notice that another device now answers at its address.
        if (
          isOnline(id) &&
          (s.learnedMac === undefined || now - s.lastVerifyAt >= VERIFY_EVERY_MS)
        ) {
          s.lastVerifyAt = now;
          await this.verify(id, s);
        }
        if (isOnline(id) && s.issue !== 'identity_changed') continue;
        s.quietSince ??= now;
        if (now - s.quietSince < LOST_AFTER_MS || now < s.nextTryAt) continue;
        await this.search(id, s, claimed);
      }
    } finally {
      this.running = false;
    }
  }

  /** Where the device is being run now: the address it moved to, or the cloud's. */
  private here(s: State): string {
    return s.moved?.to ?? s.spec.host;
  }

  private async verify(id: string, s: State) {
    const seen = (await this.table()).get(this.here(s));
    if (!seen) return;
    const known = normaliseMac(s.spec.tracking.mac);
    if (known && seen !== known) {
      this.log('warn', 'A tracked device answers, but its MAC is not the one recorded', {
        deviceId: id,
        host: this.here(s),
      });
      s.issue = 'identity_changed';
      return;
    }
    if (s.issue === 'identity_changed') s.issue = null;
    s.learnedMac = seen;
  }

  private async search(id: string, s: State, claimed: ReadonlySet<string>) {
    const from = this.here(s);
    const result = await recoverAddress({ ...s.spec, host: from }, claimed, this.deps).catch(
      (e: unknown) => {
        this.log('warn', 'Looking for a moved device failed', { deviceId: id, error: String(e) });
        return { kind: 'none' } as Recovery;
      },
    );
    const now = this.deps.now();
    s.tries++;
    s.nextTryAt = now + Math.min(RETRY_LONGEST_MS, RETRY_FIRST_MS * 2 ** (s.tries - 1));
    if (result.kind === 'moved') {
      this.log('info', 'Found a device at a new address', {
        deviceId: id,
        from,
        to: result.address,
        how: result.how,
      });
      s.moved = { from: s.moved?.from ?? s.spec.host, to: result.address, how: result.how };
      s.candidates = null;
      s.issue = null;
      s.tries = 0;
      s.quietSince = null;
      s.learnedMac = undefined;
      this.arpCache = null;
      this.onMoved(id);
      return;
    }
    if (result.kind === 'ambiguous') s.candidates = result.candidates;
    else {
      s.candidates = null;
      if (s.issue !== 'identity_changed') s.issue = 'not_found';
    }
  }
}
