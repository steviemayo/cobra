import { z } from 'zod';

// Finding devices on a gateway's local network. The gateway does the looking (the discover_devices
// command); this file holds the pure parts the portal needs: checking the network a person typed,
// reading the gateway's answer defensively, guessing what each thing is from the ports that
// answered, and noticing what the register already has. Nothing here touches a database or the
// browser, so the UI can use it too.

// ---- Which network ------------------------------------------------------------------------------

/**
 * One /24 written as three numbers ("192.168.1"), inside a private range (10/8, 172.16/12,
 * 192.168/16). Returns the cleaned value, or null when it is not one. The portal never asks a
 * gateway to look at a public address.
 */
export function parseSubnet(input: string): string | null {
  const text = input.trim();
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(text)) return null;
  const p = text.split('.').map(Number);
  if (p.some((n) => n > 255)) return null;
  const [a, b] = p as [number, number, number];
  const privateRange = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  return privateRange ? p.join('.') : null;
}

// ---- What the gateway reports -------------------------------------------------------------------

export const MAX_FOUND = 100;
const str = (n: number) => z.string().max(n).optional().catch(undefined);

const FoundHost = z.object({
  host: z.string().trim().min(1).max(64),
  ports: z.array(z.number().int().min(1).max(65535)).max(20).catch([]),
  kind: str(100),
  name: str(100),
  manufacturer: str(100),
  model: str(100),
  mac: str(40),
  note: str(200),
});
export type FoundHost = z.infer<typeof FoundHost>;

export interface DiscoveryReport {
  subnets: string[];
  hostsScanned: number;
  found: FoundHost[];
  truncated: boolean;
}

/** Reads a gateway's output without trusting it. Anything unreadable is dropped, never thrown. */
export function parseDiscoveryOutput(output: unknown): DiscoveryReport {
  const o = output && typeof output === 'object' ? (output as Record<string, unknown>) : {};
  const rawFound = Array.isArray(o.found) ? o.found : [];
  const found: FoundHost[] = [];
  for (const item of rawFound) {
    const r = FoundHost.safeParse(item);
    // One row per address, so the list keys stay unique.
    if (r.success && !found.some((f) => f.host === r.data.host)) found.push(r.data);
  }
  const subnets = (Array.isArray(o.subnets) ? o.subnets : [])
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.slice(0, 40))
    .slice(0, 5);
  const scanned =
    typeof o.hostsScanned === 'number' && Number.isFinite(o.hostsScanned) ? o.hostsScanned : 0;
  return {
    subnets,
    hostsScanned: Math.max(0, Math.min(Math.trunc(scanned), 1_000_000)),
    found: found.slice(0, MAX_FOUND),
    truncated: o.truncated === true || rawFound.length > MAX_FOUND,
  };
}

// ---- What it probably is ------------------------------------------------------------------------

export interface Suggestion {
  /** Monitored (has a driver) or recorded only. */
  kind: 'active' | 'passive';
  /** A category id from the device catalog. Left out when it cannot be guessed. */
  category?: string;
  /** The value the Add device dialog's driver picker uses: a built-in driver id, or 'pjlink'. */
  driver?: string;
  /** Plain words for the table. */
  label: string;
  make?: string;
  note?: string;
}

// Most specific first. A port only some products use beats one many use.
const BY_PORT: { port: number; suggestion: Suggestion }[] = [
  {
    port: 1710,
    suggestion: {
      kind: 'active',
      category: 'audio_matrix',
      driver: 'qsys-core',
      label: 'Q-SYS Core',
    },
  },
  {
    port: 22023,
    suggestion: {
      kind: 'active',
      category: 'video_matrix',
      driver: 'lib:extron-sis',
      label: 'Extron switcher',
      make: 'Extron',
    },
  },
  {
    port: 5000,
    suggestion: {
      kind: 'active',
      category: 'video_matrix',
      driver: 'lib:kramer-p3000',
      label: 'Kramer switcher',
      make: 'Kramer',
    },
  },
  {
    port: 4352,
    suggestion: {
      kind: 'active',
      category: 'projector',
      driver: 'pjlink',
      label: 'Projector or display (PJLink)',
    },
  },
  {
    port: 2202,
    suggestion: {
      kind: 'passive',
      category: 'voice_capture_mic',
      label: 'Shure device',
      make: 'Shure',
      note: 'There is no driver for Shure yet, so it can only be recorded.',
    },
  },
  {
    port: 23,
    suggestion: {
      kind: 'passive',
      label: 'Telnet device',
      note: 'Telnet device: choose a driver',
    },
  },
];

/** A guess from the ports that answered. Null when nothing recognisable did. */
export function suggestForFound(found: Pick<FoundHost, 'ports'>): Suggestion | null {
  for (const { port, suggestion } of BY_PORT)
    if (found.ports.includes(port)) return { ...suggestion };
  return null;
}

// ---- Already in the register --------------------------------------------------------------------

/** An address to compare: trimmed, lower case, and without a trailing :port on an IPv4 address. */
export function normaliseHost(host: unknown): string {
  if (typeof host !== 'string') return '';
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/, '$1');
  // 192.168.001.020 is the same address as 192.168.1.20.
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) ? h.split('.').map(Number).join('.') : h;
}

export interface RegisterDevice {
  id: string;
  name: string;
  ip?: string | null;
  values?: unknown;
}

/** Every address a register device is known by: its connection settings and its recorded IP. */
export function addressesOf(d: Pick<RegisterDevice, 'ip' | 'values'>): string[] {
  const out: string[] = [];
  const v = d.values && typeof d.values === 'object' ? (d.values as Record<string, unknown>) : {};
  for (const k of ['host', 'address', 'ip']) {
    const n = normaliseHost(v[k]);
    if (n) out.push(n);
  }
  const ip = normaliseHost(d.ip);
  if (ip) out.push(ip);
  return out;
}

export interface AnnotatedHost extends FoundHost {
  suggestion: Suggestion | null;
  existing: { id: string; name: string } | null;
}

export function annotateFound(found: FoundHost[], register: RegisterDevice[]): AnnotatedHost[] {
  const byAddress = new Map<string, { id: string; name: string }>();
  for (const d of register)
    for (const a of addressesOf(d))
      if (!byAddress.has(a)) byAddress.set(a, { id: d.id, name: d.name });
  return found.map((f) => ({
    ...f,
    suggestion: suggestForFound(f),
    existing: byAddress.get(normaliseHost(f.host)) ?? null,
  }));
}
