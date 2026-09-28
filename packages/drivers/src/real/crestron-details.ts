import type { DetailStatus, DeviceDetailSection } from '@kestrel/model';
import { digPath, isRecord } from './cresnext';

// What a Crestron unit says about itself, as the sections the portal's device page shows
// (DeviceDetails in @kestrel/model). Every field is named on purpose: nothing from the login,
// certificate, SNMP, Wi-Fi or security parts of the tree ever gets near this.

type Row = { label: string; value: string; status?: DetailStatus };

/** A readable value, or undefined for anything empty or not a plain value. */
export function text(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/** Rows for the fields that are present, in the order given. Missing or blank fields are left out. */
export function rows(source: unknown, fields: [key: string, label: string][]): Row[] {
  if (!isRecord(source)) return [];
  return fields.flatMap(([key, label]) => {
    const value = text(source[key]);
    return value === undefined ? [] : [{ label, value }];
  });
}

const SENSITIVE = /pass|secret|token|key|auth|credential|cert/i;

/** "IsSyncDetected" as "Sync detected". */
export const humanize = (key: string): string =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^(Is|Has)\s+/, '')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\b(Id|Uuid|Ip|Hdmi|Hdcp)\b/g, (m) => m.toUpperCase());

/**
 * Every plain value in an object, labelled from its own field names, for a part of a device whose
 * fields are not all known in advance. Anything whose name suggests a login, key or certificate
 * is left out, as is a nested object or list.
 */
export function plainRows(source: unknown, limit = 30): Row[] {
  if (!isRecord(source)) return [];
  return Object.entries(source)
    .flatMap(([k, v]) => {
      if (k === 'Version' || SENSITIVE.test(k)) return [];
      const value = text(v);
      if (value === undefined) return [];
      return [{ label: humanize(k), value: typeof v === 'boolean' ? (v ? 'Yes' : 'No') : value }];
    })
    .slice(0, limit);
}

/** "c4.42.68.68.29.08" as "C4:42:68:68:29:08". */
export const formatMac = (mac: string): string => mac.replace(/[.-]/g, ':').toUpperCase();

/** Model, serial number, MAC and the rest of what identifies the unit: the inventory section. */
export function deviceSection(tree: unknown): DeviceDetailSection | undefined {
  const info = digPath(tree, 'Device.DeviceInfo');
  if (!isRecord(info)) return undefined;
  const out = rows(info, [
    ['Manufacturer', 'Manufacturer'],
    ['Model', 'Model'],
    ['SerialNumber', 'Serial number'],
    ['MacAddress', 'MAC address'],
    ['Name', 'Device name'],
    ['DeviceVersion', 'Firmware'],
    ['BuildDate', 'Firmware built'],
    ['RebootReason', 'Last restart'],
  ]).map((r) => (r.label === 'MAC address' ? { ...r, value: formatMac(r.value) } : r));
  const host = text(digPath(tree, 'Device.Ethernet.HostName'));
  if (host) out.push({ label: 'Host name', value: host });
  const clock = text(digPath(tree, 'Device.SystemClock.CurrentTimeWithOffset'));
  if (clock) out.push({ label: 'Device clock', value: clock });
  return { title: 'Device', rows: out };
}

const IP_TABLE_COLUMNS = ['IP ID', 'Model', 'Description', 'Address', 'Port', 'Status'];

/**
 * A control system's or panel's IP table: the units it is set up to talk to and whether each is
 * connected. Only the connected ones are marked, because a table full of unused entries reading
 * "offline" is normal, not a problem.
 */
export function ipTableRows(entries: unknown): { cells: string[]; status?: DetailStatus }[] {
  if (!isRecord(entries)) return [];
  return Object.entries(entries).flatMap(([id, e]) => {
    if (!isRecord(e)) return [];
    const status = text(e.Status) ?? '';
    return [
      {
        cells: [
          text(e.IpId) ?? id,
          text(e.Model) ?? text(e.ModelName) ?? '',
          text(e.Description) ?? '',
          text(e.Address) ?? '',
          text(e.Port) ?? '',
          status,
        ],
        ...(/^online$/i.test(status) ? { status: 'ok' as const } : {}),
      },
    ];
  });
}

export function ipTableSection(title: string, entries: unknown): DeviceDetailSection | undefined {
  const all = ipTableRows(entries);
  if (all.length === 0) return undefined;
  // Connected ones first, then by IP ID as the unit numbers them.
  const sorted = [...all].sort(
    (a, b) =>
      Number(b.status === 'ok') - Number(a.status === 'ok') ||
      a.cells[0]!.localeCompare(b.cells[0]!),
  );
  const online = all.filter((r) => r.status === 'ok').length;
  return {
    title,
    rows: [{ label: 'Connected', value: `${online} of ${all.length}` }],
    table: { columns: IP_TABLE_COLUMNS, rows: sorted.slice(0, 128) },
  };
}
