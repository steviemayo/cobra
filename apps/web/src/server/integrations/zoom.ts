import { z } from 'zod';
import {
  isObject,
  readJson,
  str,
  type ExternalDevice,
  type Provider,
  type ProviderDeps,
} from './types';

// Zoom Rooms through a Server-to-Server OAuth app. The customer creates the app in the Zoom
// Marketplace with these scopes: dashboard:read:list_zoomrooms:admin (room health) and
// room:read:list_rooms:admin. Zoom's dashboard needs a plan that includes it.
export const ZoomCredentials = z.object({
  accountId: z.string().trim().min(1).max(100),
  clientId: z.string().trim().min(1).max(100),
  clientSecret: z.string().min(1).max(500),
});
export type ZoomCredentials = z.infer<typeof ZoomCredentials>;

const tokens = new Map<string, { token: string; until: number }>();
export const clearZoomTokens = () => tokens.clear();

async function token(c: ZoomCredentials, deps: ProviderDeps): Promise<string> {
  const key = `${c.accountId}:${c.clientId}`;
  const hit = tokens.get(key);
  if (hit && hit.until > deps.now()) return hit.token;
  const res = await deps.fetch(
    `https://zoom.us/oauth/token?${new URLSearchParams({ grant_type: 'account_credentials', account_id: c.accountId })}`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`,
      },
    },
  );
  const body = await readJson(res, 'Zoom sign-in');
  const access = isObject(body) ? str(body.access_token) : null;
  if (!access) throw new Error('Zoom sign-in gave no access token');
  const ttl = isObject(body) && typeof body.expires_in === 'number' ? body.expires_in : 3600;
  tokens.set(key, { token: access, until: deps.now() + (ttl - 120) * 1000 });
  return access;
}

/** Zoom's own wording for a room that is down. Kept out of the faults list: "offline" is its own incident. */
const OFFLINE_ISSUE = /offline|not connected to zoom/i;

export function normaliseRoom(raw: unknown): ExternalDevice | null {
  if (!isObject(raw)) return null;
  const id = str(raw.id);
  const name = str(raw.room_name) ?? str(raw.name);
  if (!id || !name) return null;
  const status = (str(raw.status) ?? '').toLowerCase();
  const issues = (Array.isArray(raw.issues) ? raw.issues : [])
    .map(str)
    .filter((s): s is string => !!s && !OFFLINE_ISSUE.test(s));
  const inMeeting = status === 'inmeeting';
  return {
    externalId: id,
    name,
    roomName: name,
    category: 'conference_system',
    make: 'Zoom',
    model: 'Zoom Rooms',
    ip: str(raw.device_ip),
    firmware: str(raw.zoom_rooms_version) ?? str(raw.room_version),
    // "UnderConstruction" is a room still being set up: not down, not up.
    online: status === 'offline' ? false : status === 'underconstruction' || !status ? null : true,
    feedback: { inMeeting, roomState: inMeeting ? 'in_meeting' : 'idle' },
    issues,
  };
}

async function listRooms(c: ZoomCredentials, deps: ProviderDeps): Promise<ExternalDevice[]> {
  const bearer = await token(c, deps);
  const out: ExternalDevice[] = [];
  let next = '';
  // Zoom pages with a token that expires; cap the loop so a misbehaving answer cannot spin forever.
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({
      page_size: '300',
      ...(next ? { next_page_token: next } : {}),
    });
    const res = await deps.fetch(`https://api.zoom.us/v2/metrics/zoomrooms?${qs}`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    const body = await readJson(res, 'Zoom');
    if (!isObject(body)) break;
    for (const r of Array.isArray(body.zoom_rooms) ? body.zoom_rooms : []) {
      const d = normaliseRoom(r);
      if (d) out.push(d);
    }
    next = str(body.next_page_token) ?? '';
    if (!next) break;
  }
  return out;
}

export const zoom: Provider<ZoomCredentials> = {
  id: 'zoom',
  label: 'Zoom Rooms',
  credentials: ZoomCredentials,
  async test(c, deps) {
    // One small page proves both the sign-in and the dashboard scope.
    const bearer = await token(c, deps);
    const res = await deps.fetch('https://api.zoom.us/v2/metrics/zoomrooms?page_size=1', {
      headers: { authorization: `Bearer ${bearer}` },
    });
    await readJson(res, 'Zoom');
  },
  list: listRooms,
};
