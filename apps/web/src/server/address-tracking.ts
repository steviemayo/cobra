import { Prisma, type PrismaClient } from '@kestrel/db';
import {
  ADDRESS_TRACKING_KEY,
  HOSTNAME_RE,
  normaliseMac,
  type AddressTracking,
  type DeviceAddressReport,
} from '@kestrel/model';

// Devices whose address can change (a DHCP lease that moves). A *tracked* device is found again by
// its gateway when it goes quiet: by hostname, then by its MAC on the gateway's own network, then by
// asking what answers on its port. The cloud's part is here: what the gateway needs to recognise
// the device, what to do with what it reports, and the history of where the device has been.
// Functions take the database as a parameter so they can be tested without one.
export type AddressDb = Pick<PrismaClient, 'device' | 'deviceEvent'>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export class AddressError extends Error {}

/** The most address changes kept on a device. */
export const MAX_ADDRESS_HISTORY = 20;

export interface AddressChangeEntry {
  at: string;
  from: string;
  to: string;
  how: 'hostname' | 'mac' | 'identity' | 'manual';
}

export interface AddressSuggestion {
  at: string;
  issue?: 'identity_changed' | 'not_found';
  candidates?: { address: string; note: string }[];
}

type Row = {
  addressMode: string;
  hostname: string | null;
  mac: string | null;
  serial: string | null;
  name: string;
  refindAt: Date | null;
};

/** What the gateway is given to recognise a tracked device, or undefined for a fixed one. */
export function trackingFor(row: Row): AddressTracking | undefined {
  if (row.addressMode !== 'tracked') return undefined;
  const mac = normaliseMac(row.mac);
  return {
    ...(mac ? { mac } : {}),
    ...(row.hostname ? { hostname: row.hostname } : {}),
    ...(row.serial ? { serial: row.serial } : {}),
    name: row.name,
    ...(row.refindAt ? { refindAt: row.refindAt.toISOString() } : {}),
  };
}

/** The device's settings as the gateway gets them, with the tracking details added for a tracked one. */
export function withTracking(settings: Record<string, unknown>, row: Row): Record<string, unknown> {
  const tracking = trackingFor(row);
  return tracking ? { ...settings, [ADDRESS_TRACKING_KEY]: tracking } : settings;
}

/** Which key holds the device's address: the first of host, address, ip that has a value. Defaults to host. */
export function addressKey(values: unknown, settings?: unknown): 'host' | 'address' | 'ip' {
  for (const src of [values, settings])
    if (isObject(src))
      for (const k of ['host', 'address', 'ip'] as const)
        if (typeof src[k] === 'string' && src[k]) return k;
  return 'host';
}

export function configuredAddress(values: unknown, settings?: unknown): string | undefined {
  const k = addressKey(values, settings);
  for (const src of [values, settings])
    if (isObject(src) && typeof src[k] === 'string' && src[k]) return src[k] as string;
  return undefined;
}

/** An address a person or gateway may set: a private or link-local IPv4 address, or a plain hostname. Never a public address. */
export function validAddress(value: string): boolean {
  const v = value.trim();
  const p = v.split('.').map(Number);
  if (p.length === 4 && p.every((n) => /^\d{1,3}$/.test(String(n)) && n >= 0 && n <= 255)) {
    return (
      p[0] === 10 ||
      (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 169 && p[1] === 254)
    );
  }
  return HOSTNAME_RE.test(v) && !/^\d+(\.\d+)*$/.test(v);
}

/** Checks the tracking fields of a create or edit. Returns the cleaned values, or the message to show. */
export function checkTrackingInput(
  input: {
    addressMode?: string;
    hostname?: string | null;
    mac?: string | null;
  },
  /** The device is (or is becoming) tracked, so its MAC must be one. A fixed device's asset record is left as typed. */
  tracked: boolean,
): { ok: true; mac?: string | null; hostname?: string | null } | { ok: false; message: string } {
  if (
    input.addressMode !== undefined &&
    input.addressMode !== 'fixed' &&
    input.addressMode !== 'tracked'
  )
    return { ok: false, message: 'Choose fixed or tracked.' };
  let hostname: string | null | undefined = input.hostname;
  if (typeof hostname === 'string') {
    hostname = hostname.trim();
    if (!hostname) hostname = null;
    else if (!HOSTNAME_RE.test(hostname) || /^\d+(\.\d+)*$/.test(hostname))
      return { ok: false, message: 'That is not a hostname the gateway could look up.' };
  }
  let mac: string | null | undefined = input.mac;
  if (tracked && typeof mac === 'string' && mac.trim()) {
    const n = normaliseMac(mac);
    if (!n) return { ok: false, message: 'A MAC address looks like aa:bb:cc:dd:ee:ff.' };
    mac = n;
  }
  return { ok: true, mac, hostname };
}

/**
 * Applies what a gateway says about a tracked device's address to the row's patch: a move updates
 * the address the gateway is given (and so bumps the version), an unresolved loss leaves a suggestion
 * for a person, and being found clears it. Returns the history event to record, if any. Nothing is
 * applied for a fixed device: its address is whatever a person set.
 */
export function applyAddressReport(
  row: {
    addressMode: string;
    values: unknown;
    settings: unknown;
    addressHistory: unknown;
    addressSuggestion: unknown;
    version: number;
  },
  report: DeviceAddressReport | undefined,
  online: boolean,
  patch: Record<string, unknown>,
  now: Date,
): { from: string; to: string; how: AddressChangeEntry['how'] } | null {
  if (row.addressMode !== 'tracked') return null;
  let moved: { from: string; to: string; how: AddressChangeEntry['how'] } | null = null;
  const change = report?.change;
  if (change && validAddress(change.to)) {
    const current = configuredAddress(row.values, row.settings);
    // The gateway keeps saying "moved" until the device set carries the new address; once it
    // does, the report matches what is stored and nothing happens twice.
    if (current !== change.to.trim()) {
      const values = isObject(row.values) ? { ...row.values } : {};
      values[addressKey(row.values, row.settings)] = change.to.trim();
      patch.values = values as Prisma.InputJsonValue;
      patch.version = row.version + 1;
      const history = (Array.isArray(row.addressHistory)
        ? row.addressHistory
        : []) as unknown as AddressChangeEntry[];
      const entry: AddressChangeEntry = {
        at: now.toISOString(),
        from: current ?? change.from,
        to: change.to.trim(),
        how: change.how,
      };
      patch.addressHistory = [entry, ...history].slice(
        0,
        MAX_ADDRESS_HISTORY,
      ) as unknown as Prisma.InputJsonValue;
      patch.addressSuggestion = Prisma.DbNull;
      moved = { from: entry.from, to: entry.to, how: entry.how };
    }
  } else if (report?.issue || report?.candidates?.length) {
    const next: AddressSuggestion = {
      at: now.toISOString(),
      ...(report.issue ? { issue: report.issue } : {}),
      ...(report.candidates?.length
        ? { candidates: report.candidates.filter((c) => validAddress(c.address)).slice(0, 10) }
        : {}),
    };
    // Only rewrite it when it says something new, so a heartbeat every 30s does not write every time.
    const prev = row.addressSuggestion as AddressSuggestion | null;
    if (
      !prev ||
      prev.issue !== next.issue ||
      JSON.stringify(prev.candidates) !== JSON.stringify(next.candidates)
    )
      patch.addressSuggestion = next as unknown as Prisma.InputJsonValue;
  } else if (online && row.addressSuggestion) {
    patch.addressSuggestion = Prisma.DbNull;
  }
  return moved;
}

/** A person picks one of the suggested addresses (or types one): the device is told to use it. */
export async function useAddress(
  db: AddressDb,
  input: { orgId: string; deviceId: string; address: string; actorId: string | null },
  now = new Date(),
): Promise<void> {
  const address = input.address.trim();
  if (!validAddress(address)) throw new AddressError('That is not an address a gateway may use.');
  const row = await db.device.findFirst({ where: { id: input.deviceId, orgId: input.orgId } });
  if (!row) throw new AddressError('No such device.');
  if (row.kind !== 'active')
    throw new AddressError('Only a monitored device has an address to change.');
  const current = configuredAddress(row.values, row.settings);
  if (current === address) return;
  const values = isObject(row.values) ? { ...row.values } : {};
  values[addressKey(row.values, row.settings)] = address;
  const history = (Array.isArray(row.addressHistory)
    ? row.addressHistory
    : []) as unknown as AddressChangeEntry[];
  const entry: AddressChangeEntry = {
    at: now.toISOString(),
    from: current ?? '',
    to: address,
    how: 'manual',
  };
  await db.device.update({
    where: { id: row.id },
    data: {
      values: values as Prisma.InputJsonValue,
      version: row.version + 1,
      addressHistory: [entry, ...history].slice(
        0,
        MAX_ADDRESS_HISTORY,
      ) as unknown as Prisma.InputJsonValue,
      addressSuggestion: Prisma.DbNull,
    },
  });
  await db.deviceEvent.create({
    data: {
      orgId: row.orgId,
      deviceId: row.id,
      type: 'address_changed',
      field: 'address',
      oldValue: current ?? null,
      newValue: address,
      source: 'manual',
      actorId: input.actorId,
      at: now,
    },
  });
}

/** "Find again": the gateway looks for the device now. Works by changing what the gateway is sent. */
export async function requestRefind(
  db: AddressDb,
  input: { orgId: string; deviceId: string },
  now = new Date(),
): Promise<void> {
  const row = await db.device.findFirst({ where: { id: input.deviceId, orgId: input.orgId } });
  if (!row) throw new AddressError('No such device.');
  if (row.addressMode !== 'tracked')
    throw new AddressError('Turn on address tracking for this device first.');
  await db.device.update({
    where: { id: row.id },
    data: { refindAt: now, version: row.version + 1 },
  });
}
