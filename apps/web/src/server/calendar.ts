import { createSign } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '@kestrel/db';
import { open } from '@kestrel/crypto';
import { MAX_MEETINGS, type Meeting } from '@kestrel/model';
import { queueTrigger, type ControlDb } from './control-service';

// Calendar triggers: a room's calendar starts a meeting, so the room starts itself. Kestrel reads
// the room's calendar (Microsoft 365 through Graph, or Google Calendar) from a job that runs about
// once a minute, and for each meeting that has just begun it asks the room's gateway to run the
// trigger. Each meeting fires once, however often the job looks. Only meeting starts are used.
export type CalendarDb = ControlDb &
  Pick<PrismaClient, 'calendarConnection' | 'calendarFire' | 'release'>;

export const CalendarCredentials = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('graph'),
    tenantId: z.string().trim().min(1).max(100),
    clientId: z.string().trim().min(1).max(100),
    clientSecret: z.string().min(1).max(500),
  }),
  z.object({
    provider: z.literal('google'),
    clientEmail: z.string().trim().email().max(200),
    privateKey: z.string().min(50).max(5000),
  }),
]);
export type CalendarCredentials = z.infer<typeof CalendarCredentials>;

export interface CalendarEvent {
  id: string;
  start: Date;
}

export interface Deps {
  fetch: typeof fetch;
  secretsKey: string | undefined;
}
const realDeps = (): Deps => ({ fetch, secretsKey: process.env.KESTREL_SECRETS_KEY });

/** Looking back this far catches a meeting that started while the job was between runs. */
export const LOOKBACK_MS = 3 * 60_000;
/** Starting a hair early is fine: rooms warm up. */
export const LOOKAHEAD_MS = 30_000;

// ---- Providers -----------------------------------------------------------------------------------

const tokens = new Map<string, { token: string; until: number }>();
/** Forget signed-in tokens, so the next read signs in again. */
export const clearTokenCache = () => tokens.clear();

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  if (!res.ok) throw new Error(`${what} answered HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function graphToken(
  c: Extract<CalendarCredentials, { provider: 'graph' }>,
  deps: Deps,
  now: number,
) {
  const key = `graph:${c.tenantId}:${c.clientId}`;
  const hit = tokens.get(key);
  if (hit && hit.until > now + 60_000) return hit.token;
  const res = await deps.fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: c.clientId,
        client_secret: c.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const body = await json(res, 'Microsoft sign-in');
  const token = String(body.access_token ?? '');
  if (!token) throw new Error('Microsoft did not return an access token');
  tokens.set(key, { token, until: now + Number(body.expires_in ?? 3000) * 1000 });
  return token;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

async function googleToken(
  c: Extract<CalendarCredentials, { provider: 'google' }>,
  deps: Deps,
  now: number,
) {
  const key = `google:${c.clientEmail}`;
  const hit = tokens.get(key);
  if (hit && hit.until > now + 60_000) return hit.token;
  const iat = Math.floor(now / 1000);
  const claims = {
    iss: c.clientEmail,
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600,
  };
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(c.privateKey.replace(/\\n/g, '\n'));
  const res = await deps.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${b64url(signature)}`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await json(res, 'Google sign-in');
  const token = String(body.access_token ?? '');
  if (!token) throw new Error('Google did not return an access token');
  tokens.set(key, { token, until: now + Number(body.expires_in ?? 3000) * 1000 });
  return token;
}

/** Meetings in a room's calendar that start between `from` and `to`. */
export async function meetingsStarting(
  creds: CalendarCredentials,
  resourceId: string,
  from: Date,
  to: Date,
  deps: Deps,
  now = Date.now(),
): Promise<CalendarEvent[]> {
  if (creds.provider === 'graph') {
    const token = await graphToken(creds, deps, now);
    // calendarView returns meetings that overlap the window, so ask wider and filter on the start.
    const url = new URL(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(resourceId)}/calendarView`,
    );
    url.searchParams.set('startDateTime', new Date(from.getTime() - 60_000).toISOString());
    url.searchParams.set('endDateTime', new Date(to.getTime() + 60_000).toISOString());
    url.searchParams.set('$select', 'id,start,isCancelled,isAllDay');
    url.searchParams.set('$top', '50');
    const res = await deps.fetch(url, {
      headers: { authorization: `Bearer ${token}`, prefer: 'outlook.timezone="UTC"' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await json(res, 'Microsoft Calendar');
    const events = (Array.isArray(body.value) ? body.value : []) as {
      id?: string;
      isCancelled?: boolean;
      isAllDay?: boolean;
      start?: { dateTime?: string };
    }[];
    return events.flatMap((e) => {
      if (!e.id || e.isCancelled || e.isAllDay || !e.start?.dateTime) return [];
      // With the UTC preference Graph returns "2026-09-24T08:30:00.0000000" with no zone.
      const start = new Date(
        /[zZ]|[+-]\d\d:\d\d$/.test(e.start.dateTime) ? e.start.dateTime : `${e.start.dateTime}Z`,
      );
      return Number.isNaN(start.getTime()) ? [] : [{ id: e.id, start }];
    });
  }

  const token = await googleToken(creds, deps, now);
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(resourceId)}/events`,
  );
  url.searchParams.set('timeMin', new Date(from.getTime() - 60_000).toISOString());
  url.searchParams.set('timeMax', new Date(to.getTime() + 60_000).toISOString());
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '50');
  const res = await deps.fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await json(res, 'Google Calendar');
  const items = (Array.isArray(body.items) ? body.items : []) as {
    id?: string;
    status?: string;
    start?: { dateTime?: string };
  }[];
  // All-day events carry a date, not a dateTime, and are skipped.
  return items.flatMap((e) => {
    if (!e.id || e.status === 'cancelled' || !e.start?.dateTime) return [];
    const start = new Date(e.start.dateTime);
    return Number.isNaN(start.getTime()) ? [] : [{ id: e.id, start }];
  });
}

const utc = (dateTime: string) =>
  new Date(/[zZ]|[+-]\d\d:\d\d$/.test(dateTime) ? dateTime : `${dateTime}Z`);

/**
 * The meetings in a room's calendar that overlap `from` to `to`, for showing on the room's panel.
 * Read only. A meeting marked private or confidential comes back with its title and organiser
 * removed, so they never leave Kestrel. Cancelled and all-day entries are left out.
 */
export async function meetingsBetween(
  creds: CalendarCredentials,
  resourceId: string,
  from: Date,
  to: Date,
  deps: Deps,
  now = Date.now(),
  limit = MAX_MEETINGS * 2,
): Promise<Meeting[]> {
  const shape = (
    id: string,
    start: Date,
    end: Date,
    hidden: boolean,
    title: string | undefined,
    organiser: string | undefined,
  ): Meeting[] =>
    Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start
      ? []
      : [
          {
            id,
            title: hidden ? '' : (title ?? '').slice(0, 200),
            ...(hidden || !organiser ? {} : { organiser: organiser.slice(0, 200) }),
            start: start.toISOString(),
            end: end.toISOString(),
            private: hidden,
          },
        ];

  if (creds.provider === 'graph') {
    const token = await graphToken(creds, deps, now);
    const url = new URL(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(resourceId)}/calendarView`,
    );
    url.searchParams.set('startDateTime', from.toISOString());
    url.searchParams.set('endDateTime', to.toISOString());
    url.searchParams.set(
      '$select',
      'id,subject,organizer,start,end,isCancelled,isAllDay,sensitivity',
    );
    url.searchParams.set('$orderby', 'start/dateTime');
    url.searchParams.set('$top', String(limit));
    const res = await deps.fetch(url, {
      headers: { authorization: `Bearer ${token}`, prefer: 'outlook.timezone="UTC"' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await json(res, 'Microsoft Calendar');
    const events = (Array.isArray(body.value) ? body.value : []) as {
      id?: string;
      subject?: string;
      isCancelled?: boolean;
      isAllDay?: boolean;
      sensitivity?: string;
      organizer?: { emailAddress?: { name?: string; address?: string } };
      start?: { dateTime?: string };
      end?: { dateTime?: string };
    }[];
    return events.flatMap((e) =>
      !e.id || e.isCancelled || e.isAllDay || !e.start?.dateTime || !e.end?.dateTime
        ? []
        : shape(
            e.id,
            utc(e.start.dateTime),
            utc(e.end.dateTime),
            !!e.sensitivity && e.sensitivity !== 'normal',
            e.subject,
            e.organizer?.emailAddress?.name || e.organizer?.emailAddress?.address,
          ),
    );
  }

  const token = await googleToken(creds, deps, now);
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(resourceId)}/events`,
  );
  url.searchParams.set('timeMin', from.toISOString());
  url.searchParams.set('timeMax', to.toISOString());
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', String(limit));
  const res = await deps.fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await json(res, 'Google Calendar');
  const items = (Array.isArray(body.items) ? body.items : []) as {
    id?: string;
    status?: string;
    summary?: string;
    visibility?: string;
    organizer?: { displayName?: string; email?: string };
    start?: { dateTime?: string };
    end?: { dateTime?: string };
  }[];
  return items.flatMap((e) =>
    !e.id || e.status === 'cancelled' || !e.start?.dateTime || !e.end?.dateTime
      ? []
      : shape(
          e.id,
          new Date(e.start.dateTime),
          new Date(e.end.dateTime),
          e.visibility === 'private' || e.visibility === 'confidential',
          e.summary,
          e.organizer?.displayName || e.organizer?.email,
        ),
  );
}

/** A saved profile's credentials, opened. Null when it can't be read (wrong key, damaged). */
export function openProfile(
  c: { provider: string; sealed: string },
  secretsKey: string,
): CalendarCredentials | null {
  try {
    return CalendarCredentials.parse({
      provider: c.provider,
      ...JSON.parse(open(c.sealed, secretsKey)),
    });
  } catch {
    return null;
  }
}

/** Checks the credentials by signing in. Used when someone adds a connection. */
export async function testCredentials(
  creds: CalendarCredentials,
  deps: Deps = realDeps(),
): Promise<void> {
  tokens.clear();
  if (creds.provider === 'graph') await graphToken(creds, deps, Date.now());
  else await googleToken(creds, deps, Date.now());
}

// ---- The job -------------------------------------------------------------------------------------

export interface CalendarTrigger {
  id: string;
  provider: 'graph' | 'google';
  resourceId: string;
}

export function calendarTriggers(manifest: unknown): CalendarTrigger[] {
  const triggers = (manifest as { manifest?: { model?: { triggers?: unknown[] } } })?.manifest
    ?.model?.triggers;
  if (!Array.isArray(triggers)) return [];
  return triggers.flatMap((t) => {
    const x = t as {
      type?: string;
      enabled?: boolean;
      id?: string;
      provider?: string;
      resourceId?: string;
    };
    return x.type === 'calendar' &&
      x.enabled !== false &&
      x.id &&
      x.resourceId &&
      (x.provider === 'graph' || x.provider === 'google')
      ? [{ id: x.id, provider: x.provider, resourceId: x.resourceId }]
      : [];
  });
}

export interface PollSummary {
  checked: number;
  fired: number;
  errors: string[];
}

/**
 * One pass over every room that has a calendar trigger. A calendar that can't be read is
 * reported and skipped; it never stops the other rooms.
 */
export async function pollCalendars(
  db: CalendarDb,
  now = new Date(),
  deps: Deps = realDeps(),
): Promise<PollSummary> {
  const summary: PollSummary = { checked: 0, fired: 0, errors: [] };
  if (!deps.secretsKey) return summary;
  const connections = await db.calendarConnection.findMany({});
  if (connections.length === 0) return summary;

  const creds = new Map<string, CalendarCredentials>();
  for (const c of connections) {
    try {
      creds.set(
        `${c.orgId}:${c.provider}`,
        CalendarCredentials.parse({
          provider: c.provider,
          ...JSON.parse(open(c.sealed, deps.secretsKey)),
        }),
      );
    } catch {
      summary.errors.push(`${c.provider} connection for ${c.orgId} could not be read`);
    }
  }
  const orgs = new Set(connections.map((c) => c.orgId));

  const rooms = (await db.room.findMany({})).filter(
    (r) => orgs.has(r.orgId as string) && r.gatewayId && r.desiredReleaseId,
  ) as { id: string; orgId: string; desiredReleaseId: string }[];
  if (rooms.length === 0) return summary;
  const releases = await db.release.findMany({
    where: { id: { in: rooms.map((r) => r.desiredReleaseId) } },
  });
  const byId = new Map(releases.map((r) => [r.id, r]));

  const from = new Date(now.getTime() - LOOKBACK_MS);
  const to = new Date(now.getTime() + LOOKAHEAD_MS);
  for (const room of rooms) {
    for (const t of calendarTriggers(byId.get(room.desiredReleaseId)?.manifest)) {
      const c = creds.get(`${room.orgId}:${t.provider}`);
      if (!c) continue;
      summary.checked++;
      try {
        for (const e of await meetingsStarting(c, t.resourceId, from, to, deps, now.getTime())) {
          if (e.start < from || e.start > to) continue;
          const eventKey = `${e.id}@${e.start.toISOString()}`;
          try {
            await db.calendarFire.create({
              data: { orgId: room.orgId, roomId: room.id, triggerId: t.id, eventKey, firedAt: now },
            });
          } catch (err) {
            if ((err as { code?: string }).code === 'P2002') continue; // already fired for this meeting
            throw err;
          }
          const res = await queueTrigger(
            db,
            { orgId: room.orgId, roomId: room.id, triggerId: t.id },
            now,
          );
          if (res.ok) summary.fired++;
          else summary.errors.push(`${room.id}: ${res.error}`);
        }
      } catch (err) {
        summary.errors.push(
          `${room.id} (${t.provider}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return summary;
}
