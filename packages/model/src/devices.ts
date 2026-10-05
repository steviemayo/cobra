import { z } from 'zod';
import { DEVICE_CATALOG, DeviceCategory } from './room/catalog';
import { DeviceControl } from './room/device';
import { ControlPoint } from './room/points';
import type { DeviceDetails } from './runtime/device';

// v2 devices (docs/pivot-monitoring.md): a device is a first-class record in the estate, active
// (a gateway polls it through a driver) or passive (an asset record only). Everything here is pure
// so the cloud, the gateway and the portal agree on it.

export const DEVICE_KINDS = ['active', 'passive'] as const;
export const DeviceKind = z.enum(DEVICE_KINDS);
export type DeviceKind = z.infer<typeof DeviceKind>;

/** What a person can record as an asset: everything a room design could hold, plus kit Kestrel will never talk to. */
export const ASSET_ONLY_CATEGORIES = [
  'computer',
  'media_player',
  'network_switch',
  'wireless_ap',
  'router_firewall',
  'ups',
  'server',
  'nas',
  'signage_player',
  'intercom',
  'access_control',
  'printer',
  'network_device',
  'wireless_presenter',
  'cabling',
  'other',
] as const;
export const AssetCategory = z.union([DeviceCategory, z.enum(ASSET_ONLY_CATEGORIES)]);
export type AssetCategory = z.infer<typeof AssetCategory>;

const ASSET_ONLY_LABEL: Record<(typeof ASSET_ONLY_CATEGORIES)[number], string> = {
  computer: 'Computer or laptop',
  media_player: 'Media player',
  network_switch: 'Network switch',
  wireless_ap: 'Wireless access point',
  router_firewall: 'Router or firewall',
  ups: 'UPS',
  server: 'Server or PC',
  nas: 'Storage (NAS)',
  signage_player: 'Signage player',
  intercom: 'Intercom',
  access_control: 'Door or access control',
  printer: 'Printer',
  network_device: 'Other network device',
  wireless_presenter: 'Wireless presenter',
  cabling: 'Cabling or wall plate',
  other: 'Other',
};

/** A category's name for people. An unknown one (from a later version) shows as it is. */
export function assetCategoryLabel(category: string): string {
  const known = DEVICE_CATALOG[category as DeviceCategory]?.label;
  return known ?? ASSET_ONLY_LABEL[category as keyof typeof ASSET_ONLY_LABEL] ?? category;
}

export const ASSET_STATUSES = ['in_service', 'spare', 'in_repair', 'retired'] as const;
export const AssetStatus = z.enum(ASSET_STATUSES);
export type AssetStatus = z.infer<typeof AssetStatus>;

/** Asset fields a device can carry, with provenance. */
export const ASSET_FIELDS = ['make', 'model', 'serial', 'mac', 'ip', 'firmware'] as const;
export type AssetField = (typeof ASSET_FIELDS)[number];
/** Discovered by a driver when it can; a person can fill any of them. */
export const DISCOVERABLE_FIELDS: readonly AssetField[] = [
  'model',
  'serial',
  'mac',
  'ip',
  'firmware',
];
/** A change to one of these means the box may have been swapped for another. */
export const IDENTITY_FIELDS: readonly AssetField[] = ['serial', 'mac', 'model'];

export type FieldSource = 'discovered' | 'manual';
export interface FieldProvenance {
  source: FieldSource;
  /** Filled in from the driver, not read from the device. A real reading replaces it without flagging a swap. */
  inferred?: boolean;
  /** When source is manual and the device reports something different, what it reports. */
  discovered?: string;
  at: string;
  by?: string;
}
export type Provenance = Partial<Record<AssetField, FieldProvenance>>;

export type FieldChange = {
  field: AssetField;
  oldValue: string | null;
  newValue: string | null;
  source: FieldSource;
  /** Identity field changed: someone should say whether this is a swap or a correction. */
  possibleSwap: boolean;
};

export interface MergeResult {
  value: string | null;
  provenance: FieldProvenance | undefined;
  change?: FieldChange;
}

const clean = (v: string | null | undefined) => {
  const t = v?.trim();
  return t ? t : null;
};
/** MACs are compared without separators or case. Everything else compares as typed, minus case. */
const same = (field: AssetField, a: string | null, b: string | null) => {
  if (a === null || b === null) return a === b;
  if (field === 'mac')
    return (
      a.replace(/[^0-9a-f]/gi, '').toLowerCase() === b.replace(/[^0-9a-f]/gi, '').toLowerCase()
    );
  return a.toLowerCase() === b.toLowerCase();
};

/**
 * A driver reported `discovered` for a field. A manual value is never replaced: if the device
 * disagrees the difference is recorded on the provenance (a mismatch) and the value stays. A
 * discovered (or empty) value follows the device, and a change to an identity field is flagged.
 */
export function mergeDiscovered(
  field: AssetField,
  current: { value: string | null; provenance?: FieldProvenance },
  reported: string | null | undefined,
  now: string,
): MergeResult {
  const seen = clean(reported);
  // A value inferred from the driver is a placeholder: a real reading fills it like an empty field.
  const inferred = current.provenance?.inferred === true;
  const value = inferred && seen !== null ? null : clean(current.value);
  if (seen === null) return { value: clean(current.value), provenance: current.provenance };
  if (current.provenance?.source === 'manual' && value !== null) {
    if (same(field, value, seen)) {
      // The device now agrees with what someone typed: the note of a mismatch goes.
      const rest = { ...current.provenance };
      delete rest.discovered;
      return { value, provenance: rest };
    }
    if (current.provenance.discovered === seen) return { value, provenance: current.provenance };
    return { value, provenance: { ...current.provenance, discovered: seen } };
  }
  if (value !== null && same(field, value, seen)) {
    return { value, provenance: current.provenance ?? { source: 'discovered', at: now } };
  }
  const change: FieldChange = {
    field,
    oldValue: value,
    newValue: seen,
    source: 'discovered',
    // The first reading of an empty field is filling a gap, not a swap.
    possibleSwap: value !== null && IDENTITY_FIELDS.includes(field),
  };
  return { value: seen, provenance: { source: 'discovered', at: now }, change };
}

/** A person typed a value (or cleared it). It becomes manual unless it just matches the device. */
export function mergeManual(
  field: AssetField,
  current: { value: string | null; provenance?: FieldProvenance },
  typed: string | null | undefined,
  now: string,
  by?: string,
): MergeResult {
  const next = clean(typed);
  const value = clean(current.value);
  // Typing over an inferred value makes it a manual one, even when it is the same words.
  const wasInferred = current.provenance?.inferred === true;
  if (wasInferred) {
    current = { value: current.value };
    if (next !== null && same(field, value, next))
      return {
        value: next,
        provenance: { source: 'manual', at: now, ...(by ? { by } : {}) },
      };
  }
  if (same(field, value, next) && (next !== null || !current.provenance))
    return { value, provenance: current.provenance };
  const change: FieldChange = {
    field,
    oldValue: value,
    newValue: next,
    source: 'manual',
    possibleSwap:
      !wasInferred && value !== null && next !== null && IDENTITY_FIELDS.includes(field),
  };
  if (next === null) return { value: null, provenance: undefined, change };
  const reported =
    current.provenance?.source === 'discovered' ? value : current.provenance?.discovered;
  if (reported && same(field, reported, next))
    return {
      value: next,
      provenance: { source: 'discovered', at: now, ...(by ? { by } : {}) },
      change,
    };
  return {
    value: next,
    provenance: {
      source: 'manual',
      at: now,
      ...(by ? { by } : {}),
      ...(reported ? { discovered: reported } : {}),
    },
    change,
  };
}

const LABELS: Record<Exclude<AssetField, 'make' | 'ip' | 'firmware'>, RegExp> = {
  serial: /^(serial( number| no\.?)?|s\/n|sn)$/i,
  mac: /^(mac( address)?|ethernet mac|lan mac)$/i,
  model: /^(model( name| number)?|product( name)?|device model)$/i,
};

/**
 * Pulls serial, MAC and model out of the sections a driver's details already carry, so no driver
 * has to change to feed the register. A driver can say more later; this reads what is there.
 */
export function identityFromDetails(
  details: DeviceDetails | null | undefined,
): Partial<Record<'serial' | 'mac' | 'model', string>> {
  const out: Partial<Record<'serial' | 'mac' | 'model', string>> = {};
  for (const section of details ?? [])
    for (const row of section.rows ?? []) {
      const label = row.label.trim();
      for (const key of Object.keys(LABELS) as (keyof typeof LABELS)[])
        if (!out[key] && LABELS[key].test(label) && clean(row.value)) out[key] = row.value.trim();
    }
  return out;
}

// ---- Which gateway, and what state ----------------------------------------------------------------

/** Device gateway, else its room's, else the site's default. Null when nothing is set. */
export function resolveGatewayId(input: {
  deviceGatewayId?: string | null;
  roomGatewayId?: string | null;
  siteGatewayId?: string | null;
}): string | null {
  return input.deviceGatewayId ?? input.roomGatewayId ?? input.siteGatewayId ?? null;
}

/**
 * online / offline as the gateway last said; unknown when the gateway itself is not reachable (its
 * devices are not offline, we just cannot see them), and for a device never heard from. Passive
 * devices have no state.
 */
export type DeviceLiveState = 'online' | 'offline' | 'unknown' | 'none';
export function deviceLiveState(input: {
  kind: string;
  online: boolean | null;
  gatewayOnline: boolean;
}): DeviceLiveState {
  if (input.kind !== 'active') return 'none';
  if (!input.gatewayOnline || input.online === null) return 'unknown';
  return input.online ? 'online' : 'offline';
}

// ---- What travels to a gateway --------------------------------------------------------------------

/** One device a gateway polls. `settings` already has addresses and logins merged in. */
/** How a device's address is kept. Fixed: it never changes. Tracked: the gateway finds it again if it moves. */
export const ADDRESS_MODES = ['fixed', 'tracked'] as const;
export const AddressMode = z.enum(ADDRESS_MODES);
export type AddressMode = z.infer<typeof AddressMode>;

/**
 * What a gateway needs to recognise a tracked device after it changes address. Sent inside the
 * device's settings (key `addressTracking`) so it is signed with the rest and an older gateway just
 * ignores it. `refindAt` changes when someone presses "Find again".
 */
export const AddressTracking = z.object({
  mac: z.string().max(40).optional(),
  hostname: z.string().max(253).optional(),
  serial: z.string().max(100).optional(),
  name: z.string().max(100).optional(),
  refindAt: z.string().max(40).optional(),
});
export type AddressTracking = z.infer<typeof AddressTracking>;
export const ADDRESS_TRACKING_KEY = 'addressTracking';

/** A MAC as lower-case colon pairs (aa:bb:cc:dd:ee:ff), or null if it is not one. Accepts - . and bare forms. */
export function normaliseMac(raw: string | null | undefined): string | null {
  const hex = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[:.\-\s]/g, '');
  return /^[0-9a-f]{12}$/.test(hex) ? hex.match(/../g)!.join(':') : null;
}

/** A hostname a DNS or mDNS lookup could resolve: letters, digits, dots and hyphens, 253 characters at most. */
export const HOSTNAME_RE =
  /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export const MonitoredDevice = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  category: DeviceCategory.or(z.string().min(1).max(40)),
  control: DeviceControl,
  settings: z.record(z.string(), z.unknown()).default({}),
  /** The control points to read on it (a DSP's gain blocks, mutes, routers, named controls), and what to watch them for. */
  points: z.array(ControlPoint).max(200).optional(),
});
export type MonitoredDevice = z.infer<typeof MonitoredDevice>;

export const DeviceSetPayload = z.object({
  orgId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  /** Changes whenever any device in the set (or a login it uses) changes. */
  version: z.string().min(1).max(100),
  devices: z.array(MonitoredDevice).max(500),
});
export type DeviceSetPayload = z.infer<typeof DeviceSetPayload>;

/** Signed like a manifest, so a gateway polls only what Kestrel says to. */
export const SignedDeviceSet = z.object({
  payload: DeviceSetPayload,
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().min(1),
  keyId: z.string().min(1),
});
export type SignedDeviceSet = z.infer<typeof SignedDeviceSet>;
