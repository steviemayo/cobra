import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@kestrel/db';
import { assertPublicUrl, portalLink } from './alerts';

// Tickets tell people when something needs them: Kestrel staff when a ticket is escalated to them,
// and the organisation when Kestrel replies or changes its status. Teams and webhook only for now
// (email follows once the sending domain exists). Best effort: a failed notification never fails
// the request that caused it, so callers run this after responding.
export type NotifyDb = Pick<PrismaClient, 'alertChannel' | 'org'>;

export type TicketEventKind = 'escalated' | 'staff_reply' | 'status_changed' | 'handed_back';

export interface TicketEvent {
  kind: TicketEventKind;
  orgId: string;
  orgName: string;
  ticket: { id: string; title: string; priority: string; status: string };
  /** The start of the comment or note, for the message. */
  snippet?: string;
}

export interface NotifyDeps {
  fetch: typeof fetch;
  resolve?: Parameters<typeof assertPublicUrl>[1];
  env: Record<string, string | undefined>;
}
const realDeps = (): NotifyDeps => ({ fetch, env: process.env });

const HEADLINE: Record<TicketEventKind, (e: TicketEvent) => string> = {
  escalated: (e) =>
    `${e.orgName} escalated a ticket to Kestrel (${e.ticket.priority}): ${e.ticket.title}`,
  staff_reply: (e) => `Kestrel support replied to “${e.ticket.title}”`,
  status_changed: (e) =>
    `Kestrel support marked “${e.ticket.title}” ${e.ticket.status.replace('_', ' ')}`,
  handed_back: (e) => `Kestrel support handed “${e.ticket.title}” back to your team`,
};

const snip = (s?: string) => (s ? s.replace(/\s+/g, ' ').trim().slice(0, 200) : undefined);

function body(e: TicketEvent, url: string | null) {
  const snippet = snip(e.snippet);
  return {
    // Teams incoming webhooks show `text`; everything else reads the structured fields.
    text: [HEADLINE[e.kind](e), snippet, url].filter(Boolean).join('\n'),
    event: `ticket.${e.kind}`,
    ticket: e.ticket,
    organisation: { id: e.orgId, name: e.orgName },
    snippet,
    url,
  };
}

async function post(d: NotifyDeps, rawUrl: string, payload: unknown, secret?: string) {
  const url = await assertPublicUrl(rawUrl, d.resolve);
  const text = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret) {
    const ts = String(Math.floor(Date.now() / 1000));
    headers['x-kestrel-timestamp'] = ts;
    headers['x-kestrel-signature'] =
      `sha256=${createHmac('sha256', secret).update(`${ts}.${text}`).digest('hex')}`;
  }
  const res = await d.fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers,
    body: text,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`The destination answered HTTP ${res.status}`);
}

/** Kestrel's own channel: STAFF_TICKET_WEBHOOK_URL (a Teams incoming webhook or any webhook). */
export async function notifyStaff(e: TicketEvent, d: NotifyDeps = realDeps()): Promise<boolean> {
  const url = d.env.STAFF_TICKET_WEBHOOK_URL;
  if (!url) return false;
  const base = d.env.NEXT_PUBLIC_APP_URL;
  try {
    await post(d, url, body(e, base ? `${base}/staff/tickets/${e.ticket.id}` : null));
    return true;
  } catch (err) {
    console.error('[tickets] staff notification failed', err instanceof Error ? err.message : err);
    return false;
  }
}

/** The organisation's own Teams and webhook channels. Returns how many were reached. */
export async function notifyOrg(
  db: NotifyDb,
  e: TicketEvent,
  d: NotifyDeps = realDeps(),
): Promise<number> {
  const channels = await db.alertChannel.findMany({ where: { orgId: e.orgId, enabled: true } });
  const url = portalLink(e.orgId, `/tickets/${e.ticket.id}`, d.env);
  let sent = 0;
  for (const c of channels) {
    const cfg = (c.config ?? {}) as { url?: string; secret?: string };
    if ((c.type !== 'teams' && c.type !== 'webhook') || !cfg.url) continue;
    try {
      await post(d, cfg.url, body(e, url), c.type === 'webhook' ? cfg.secret : undefined);
      sent++;
    } catch (err) {
      console.error(
        '[tickets] organisation notification failed',
        err instanceof Error ? err.message : err,
      );
    }
  }
  return sent;
}
