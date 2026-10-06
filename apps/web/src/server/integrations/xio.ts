import { z } from 'zod';
import {
  isObject,
  readJson,
  str,
  type ExternalDevice,
  type Provider,
  type ProviderDeps,
} from './types';

// Crestron XiO Cloud's public API: an account id and a subscription key sent in the
// XiO-subscription-key header. Crestron limits it hard (the account device list may be read once
// every five minutes), so this reads the one account-wide list, which already carries each device's
// status, and is read no more often than that. Needs public API access enabled on the customer's
// XiO Cloud account.
export const XioCredentials = z.object({
  accountId: z.string().trim().min(1).max(100),
  subscriptionKey: z.string().trim().min(8).max(200),
});
export type XioCredentials = z.infer<typeof XioCredentials>;

const BASE = 'https://api.crestron.io/api';

const ONLINE = /^online$/i;
const OFFLINE = /^offline$/i;

/** Crestron's device category to a Kestrel category. Anything else is a control processor, the usual XiO device. */
function categoryOf(category: string | null, model: string | null): string {
  const t = `${category ?? ''} ${model ?? ''}`.toLowerCase();
  if (/touch|tsw|tss|panel/.test(t)) return 'touch_panel';
  if (/uc-|flex|mercury|conferenc/.test(t)) return 'conference_system';
  if (/dm-|matrix|switcher/.test(t)) return 'video_matrix';
  if (/display|projector/.test(t)) return 'display';
  if (/camera|ptz/.test(t)) return 'conf_camera';
  return 'control_processor';
}

export function normaliseDevice(raw: unknown): ExternalDevice | null {
  // Some answers wrap each device in a "device" object.
  const d = isObject(raw) && isObject(raw.device) ? { ...raw, ...raw.device } : raw;
  if (!isObject(d)) return null;
  const id = str(d['device-cid']) ?? str(d['device-id']);
  const name = str(d['user-device-name']) ?? str(d['device-name']);
  if (!id || !name) return null;
  const status = str(d['device-status']);
  const model = str(d['device-model']);
  return {
    externalId: id,
    name,
    roomName: name,
    category: categoryOf(str(d['device-category']), model),
    make: str(d['device-manufacturer']) ?? 'Crestron',
    model,
    serial: str(d['serial-number']),
    ip: str(d.ipAddress) ?? str(d['nic-1-ip-address']),
    mac: str(d['nic-1-mac-address']),
    firmware: str(d['firmware-version']),
    online:
      status === null ? null : OFFLINE.test(status) ? false : ONLINE.test(status) ? true : null,
    issues: [],
  };
}

async function fetchDevices(c: XioCredentials, deps: ProviderDeps): Promise<unknown[]> {
  const res = await deps.fetch(
    `${BASE}/v1/device/accountid/${encodeURIComponent(c.accountId)}/devices`,
    { headers: { 'XiO-subscription-key': c.subscriptionKey, accept: 'application/json' } },
  );
  const body = await readJson(res, 'Crestron XiO Cloud');
  const list = Array.isArray(body)
    ? body
    : isObject(body)
      ? (['devices', 'Devices', 'data', 'items'] as const).map((k) => body[k]).find(Array.isArray)
      : undefined;
  if (!Array.isArray(list))
    throw new Error('Crestron XiO Cloud answered in a form we did not expect');
  return list;
}

export const xio: Provider<XioCredentials> = {
  id: 'xio',
  label: 'Crestron XiO Cloud',
  // Crestron allows the account device list once every five minutes. A little over, to be safe.
  intervalMs: 6 * 60_000,
  credentials: XioCredentials,
  async test(c, deps) {
    await fetchDevices(c, deps);
  },
  async list(c, deps) {
    return (await fetchDevices(c, deps))
      .map(normaliseDevice)
      .filter((d): d is ExternalDevice => d !== null);
  },
};
