import { z } from 'zod';
import {
  isObject,
  readJson,
  str,
  type ExternalDevice,
  type Provider,
  type ProviderDeps,
} from './types';

// Logitech Sync Cloud API: mutual TLS with a certificate the customer generates in the Sync portal
// (Settings, Sync Cloud API), plus their organisation id. Needs a Sync Plus, Essential or Select
// licence. The one documented call is GET /org/{orgId}/place, which lists rooms with their devices
// and occupancy. Field names follow Logitech's published API as read through a third-party client
// (camelCase); the parser tolerates missing fields and has not yet been run against a live tenant.

const DEFAULT_BASE = 'https://api.sync.logitech.com/v1';

export const LogitechCredentials = z.object({
  orgId: z.string().trim().min(1).max(100),
  certificate: z
    .string()
    .trim()
    .min(100)
    .max(20_000)
    .regex(/BEGIN CERTIFICATE/, 'Paste the certificate (PEM)'),
  privateKey: z
    .string()
    .trim()
    .min(100)
    .max(20_000)
    .regex(/BEGIN [A-Z ]*PRIVATE KEY/, 'Paste the private key (PEM)'),
  /** Regional tenants use another address. Only Logitech hosts are accepted. */
  apiBase: z
    .string()
    .trim()
    .max(200)
    .optional()
    .refine((v) => {
      if (!v) return true;
      try {
        const u = new URL(v);
        return u.protocol === 'https:' && /(^|\.)logitech\.com$/i.test(u.hostname);
      } catch {
        return false;
      }
    }, 'The address must be an https Logitech address'),
});
export type LogitechCredentials = z.infer<typeof LogitechCredentials>;

const base = (c: LogitechCredentials) => (c.apiBase || DEFAULT_BASE).replace(/\/+$/, '');

const ONLINE = /^(online|connected|up|ok|ready|active)$/i;
const OFFLINE = /^(offline|disconnected|down|unreachable|lost)$/i;
const HEALTHY = /^(healthy|ok|good|normal|none)$/i;

/** Logitech's device type to a Kestrel category. Anything else is a conference system. */
function categoryOf(type: string | null): string {
  const t = (type ?? '').toLowerCase();
  if (/camera|rally cam|brio|meetup|sight/.test(t)) return 'conf_camera';
  if (/mic|pod/.test(t)) return 'voice_capture_mic';
  if (/speaker/.test(t)) return 'audio_destination';
  if (/display/.test(t)) return 'display';
  return 'conference_system';
}

export function normalisePlace(raw: unknown): ExternalDevice[] {
  if (!isObject(raw)) return [];
  const placeName = str(raw.name);
  const occupancy = typeof raw.occupancy === 'number' ? raw.occupancy : null;
  const out: ExternalDevice[] = [];
  for (const d of Array.isArray(raw.devices) ? raw.devices : []) {
    if (!isObject(d)) continue;
    const id = str(d.id);
    const name = str(d.name) ?? placeName;
    if (!id || !name) continue;
    const status = str(d.status);
    const health = str(d.healthStatus);
    const online =
      status === null ? null : OFFLINE.test(status) ? false : ONLINE.test(status) ? true : null;
    out.push({
      externalId: id,
      name,
      roomName: placeName,
      category: categoryOf(str(d.type)),
      make: 'Logitech',
      model: str(d.type),
      serial: str(d.serial),
      firmware: str(d.version),
      online,
      ...(occupancy === null
        ? {}
        : {
            feedback: { occupied: occupancy > 0, peopleCount: Math.max(0, Math.round(occupancy)) },
          }),
      issues:
        online !== false && health && !HEALTHY.test(health)
          ? [`${name} reports its health as ${health}`]
          : [],
    });
  }
  return out;
}

async function fetchPlaces(
  c: LogitechCredentials,
  deps: ProviderDeps,
  limit: number,
  maxPages: number,
) {
  const out: unknown[] = [];
  let continuation = '';
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({
      limit: String(limit),
      rooms: 'true',
      projection: 'place.info,place.occupancy,place.device,place.device.info,place.device.status',
      ...(continuation ? { continuation } : {}),
    });
    const res = await deps.mtlsGet(`${base(c)}/org/${encodeURIComponent(c.orgId)}/place?${qs}`, {
      cert: c.certificate,
      key: c.privateKey,
    });
    const body = await readJson(res, 'Logitech Sync');
    if (!isObject(body)) throw new Error('Logitech Sync answered in a form we did not expect');
    if (Array.isArray(body.places)) out.push(...body.places);
    continuation = str(body.continuation) ?? '';
    if (!continuation) break;
  }
  return out;
}

export const logitech: Provider<LogitechCredentials> = {
  id: 'logitech',
  label: 'Logitech Sync',
  credentials: LogitechCredentials,
  async test(c, deps) {
    await fetchPlaces(c, deps, 1, 1);
  },
  async list(c, deps) {
    const places = await fetchPlaces(c, deps, 1000, 20);
    return places.flatMap(normalisePlace);
  },
};
