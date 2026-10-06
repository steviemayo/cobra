import { z } from 'zod';
import {
  isObject,
  readJson,
  str,
  type ExternalDevice,
  type Provider,
  type ProviderDeps,
} from './types';

// Cisco Webex through a Service App the customer creates (and an org admin authorises in Control Hub).
// The customer pastes the app's client id and secret and its refresh token; Kestrel trades the
// refresh token for access tokens, and keeps the new refresh token Webex hands back. Scopes needed:
// spark-admin:devices_read and spark-admin:workspaces_read.
export const WebexCredentials = z.object({
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().min(1).max(500),
  refreshToken: z.string().trim().min(10).max(2000),
});
export type WebexCredentials = z.infer<typeof WebexCredentials>;

const API = 'https://webexapis.com/v1';

const tokens = new Map<string, { token: string; until: number }>();
export const clearWebexTokens = () => tokens.clear();

async function token(c: WebexCredentials, deps: ProviderDeps): Promise<string> {
  const hit = tokens.get(c.clientId);
  if (hit && hit.until > deps.now()) return hit.token;
  const res = await deps.fetch(`${API}/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
    }),
  });
  const body = await readJson(res, 'Webex sign-in');
  const access = isObject(body) ? str(body.access_token) : null;
  if (!access) throw new Error('Webex sign-in gave no access token');
  const ttl = isObject(body) && typeof body.expires_in === 'number' ? body.expires_in : 3600;
  // A refresh token that changed must be kept, or the next sign-in fails.
  const next = isObject(body) ? str(body.refresh_token) : null;
  if (next && next !== c.refreshToken && deps.updateCredentials)
    await deps.updateCredentials({ ...c, refreshToken: next });
  tokens.set(c.clientId, { token: access, until: deps.now() + Math.max(60, ttl - 300) * 1000 });
  return access;
}

/** Webex answers in pages, linked by a Link header. Capped so a bad answer cannot loop. */
async function getAll(path: string, bearer: string, deps: ProviderDeps): Promise<unknown[]> {
  const out: unknown[] = [];
  let url: string | null = `${API}${path}${path.includes('?') ? '&' : '?'}max=1000`;
  for (let page = 0; page < 20 && url; page++) {
    const res: Response = await deps.fetch(url, { headers: { authorization: `Bearer ${bearer}` } });
    const body = await readJson(res, 'Webex');
    if (isObject(body) && Array.isArray(body.items)) out.push(...body.items);
    const next: string | undefined = /<([^>]+)>;\s*rel="next"/.exec(
      res.headers.get('link') ?? '',
    )?.[1];
    // Only follow a next link that stays on Webex.
    url = next && next.startsWith(`${API}/`) ? next : null;
  }
  return out;
}

const ONLINE = /^connected$/i;
const ONLINE_WITH_ISSUES = /^connected_with_issues$/i;
const OFFLINE = /offline|disconnected/i;

export function normaliseDevice(
  raw: unknown,
  workspaces: Map<string, string>,
): ExternalDevice | null {
  if (!isObject(raw)) return null;
  const id = str(raw.id);
  const name = str(raw.displayName);
  if (!id || !name) return null;
  const status = str(raw.connectionStatus);
  const online =
    status === null
      ? null
      : OFFLINE.test(status)
        ? false
        : ONLINE.test(status) || ONLINE_WITH_ISSUES.test(status)
          ? true
          : null;
  const codes = (Array.isArray(raw.errorCodes) ? raw.errorCodes : [])
    .map((e) => str(e))
    .filter((e): e is string => !!e);
  const issues = online === false ? [] : [...codes];
  if (online && status && ONLINE_WITH_ISSUES.test(status) && issues.length === 0)
    issues.push(`${name} reports problems`);
  const workspaceId = str(raw.workspaceId) ?? str(raw.placeId);
  return {
    externalId: id,
    name,
    roomName: (workspaceId && workspaces.get(workspaceId)) || name,
    category: 'conference_system',
    make: 'Cisco',
    model: str(raw.product),
    serial: str(raw.serial),
    mac: str(raw.mac),
    ip: str(raw.ip),
    firmware: str(raw.software),
    online,
    issues,
  };
}

export const webex: Provider<WebexCredentials> = {
  id: 'webex',
  label: 'Cisco Webex',
  credentials: WebexCredentials,
  async test(c, deps) {
    const bearer = await token(c, deps);
    const res = await deps.fetch(`${API}/devices?max=1`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    await readJson(res, 'Webex');
  },
  async list(c, deps) {
    const bearer = await token(c, deps);
    const devices = await getAll('/devices', bearer, deps);
    // Room names are a nicety: a customer without the workspaces scope still gets their devices.
    const workspaces = new Map<string, string>();
    try {
      for (const w of await getAll('/workspaces', bearer, deps))
        if (isObject(w) && str(w.id) && str(w.displayName))
          workspaces.set(str(w.id)!, str(w.displayName)!);
    } catch {
      /* names fall back to the device name */
    }
    return devices
      .map((d) => normaliseDevice(d, workspaces))
      .filter((d): d is ExternalDevice => d !== null);
  },
};
