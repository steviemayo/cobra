import { z } from 'zod';
import {
  isObject,
  readJson,
  str,
  type ExternalDevice,
  type Provider,
  type ProviderDeps,
} from './types';

// Q-SYS Reflect's public API: one bearer token, copied by an Organization Owner from the
// Organizations page. It lists Cores with their status, so a Core can be watched with no gateway.
export const ReflectCredentials = z.object({
  apiToken: z.string().trim().min(20, 'That token looks too short').max(200),
});
export type ReflectCredentials = z.infer<typeof ReflectCredentials>;

const BASE = 'https://reflect.qsc.com/api/public/v0';

/** Reflect's status code for a Core it cannot reach. Any other non-zero code is a fault on a Core that is up. */
const OFFLINE_CODE = 7;
const OFFLINE_WORDS = /offline|unreachable|not connected|missing/i;

export function normaliseCore(raw: unknown): ExternalDevice | null {
  if (!isObject(raw)) return null;
  const id = raw.id === undefined || raw.id === null ? null : String(raw.id);
  const serial = str(raw.serial);
  const key = id ?? serial;
  const name = str(raw.name) ?? serial;
  if (!key || !name) return null;
  const status = isObject(raw.status) ? raw.status : {};
  const code = typeof status.code === 'number' ? status.code : null;
  const message = str(status.message);
  const details = str(status.details);
  const offline = code === OFFLINE_CODE || (code !== 0 && !!message && OFFLINE_WORDS.test(message));
  const faulted = code !== null && code !== 0 && !offline;
  return {
    externalId: key,
    name,
    roomName: name,
    category: 'dsp',
    make: 'QSC',
    model: str(raw.model) ?? str(raw.modelNumber),
    serial,
    firmware: str(raw.firmware),
    online: code === null ? null : !offline,
    issues: faulted ? [[message, details].filter(Boolean).join(': ') || `Status code ${code}`] : [],
  };
}

async function get(c: ReflectCredentials, deps: ProviderDeps) {
  const res = await deps.fetch(`${BASE}/cores`, {
    headers: { authorization: `Bearer ${c.apiToken}`, accept: 'application/json' },
  });
  return readJson(res, 'Q-SYS Reflect');
}

export const reflect: Provider<ReflectCredentials> = {
  id: 'reflect',
  label: 'Q-SYS Reflect',
  credentials: ReflectCredentials,
  async test(c, deps) {
    await get(c, deps);
  },
  async list(c, deps) {
    const body = await get(c, deps);
    if (!Array.isArray(body)) throw new Error('Q-SYS Reflect answered in a form we did not expect');
    return body.map(normaliseCore).filter((d): d is ExternalDevice => d !== null);
  },
};
