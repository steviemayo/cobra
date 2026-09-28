import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@kestrel/db';
import { portalLink } from './alerts';
import { pinnedFetch, postJson, type Lookup } from './outbound';

// Tickets tell people when something needs them: Kestrel staff when a ticket is escalated to them,
// and the organisation when Kestrel replies or changes its status. Through Teams, webhooks and
// email (an email needs RESEND_API_KEY and ALERT_FROM_EMAIL on the server; without them email is
// quietly skipped). Best effort: a failed notification never fails the request that caused it, so
// callers run this after responding.
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
  resolve?: Lookup;
  env: Record<string, string | undefined>;
}
export const realDeps = (): NotifyDeps => ({ fetch: pinnedFetch, env: process.env });

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

export async function post(d: NotifyDeps, rawUrl: string, payload: unknown, secret?: string) {
  const text = JSON.stringify(payload);
  const headers: Record<string, string> = {};
  if (secret) {
    const ts = String(Math.floor(Date.now() / 1000));
    headers['x-kestrel-timestamp'] = ts;
    headers['x-kestrel-signature'] =
      `sha256=${createHmac('sha256', secret).update(`${ts}.${text}`).digest('hex')}`;
  }
  await postJson(d, rawUrl, text, headers);
}

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const MAX_RECIPIENTS = 10;

/** Addresses from a comma or semicolon separated list, keeping only well-formed ones. */
export function parseAddresses(list: string | undefined): string[] {
  return [
    ...new Set(
      (list ?? '')
        .split(/[,;]/)
        .map((a) => a.trim())
        .filter((a) => EMAIL.test(a)),
    ),
  ].slice(0, MAX_RECIPIENTS);
}

/**
 * Sends a plain text email through Resend. Returns false (without trying) when the server has no
 * email settings, so a Kestrel that has not set up its sending domain simply does not send.
 */
export async function sendEmail(
  d: NotifyDeps,
  to: string[],
  subject: string,
  text: string,
): Promise<boolean> {
  const key = d.env.RESEND_API_KEY;
  const from = d.env.ALERT_FROM_EMAIL;
  if (!key || !from || to.length === 0) return false;
  const res = await d.fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from,
      to: to.slice(0, MAX_RECIPIENTS),
      subject: subject.replace(/[\r\n]+/g, ' '),
      text,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`The email service answered HTTP ${res.status}`);
  return true;
}

async function email(
  d: NotifyDeps,
  to: string[],
  e: TicketEvent,
  url: string | null,
): Promise<boolean> {
  return sendEmail(d, to, `[Kestrel] ${HEADLINE[e.kind](e)}`, body(e, url).text);
}

/**
 * Kestrel's own channels: STAFF_TICKET_WEBHOOK_URL (a Teams incoming webhook or any webhook) and
 * STAFF_TICKET_EMAIL (one or more addresses). True if at least one was reached.
 */
export async function notifyStaff(e: TicketEvent, d: NotifyDeps = realDeps()): Promise<boolean> {
  const base = d.env.NEXT_PUBLIC_APP_URL;
  const url = base ? `${base}/staff/tickets/${e.ticket.id}` : null;
  let reached = false;
  const hook = d.env.STAFF_TICKET_WEBHOOK_URL;
  if (hook)
    try {
      await post(d, hook, body(e, url));
      reached = true;
    } catch (err) {
      console.error(
        '[tickets] staff notification failed',
        err instanceof Error ? err.message : err,
      );
    }
  const to = parseAddresses(d.env.STAFF_TICKET_EMAIL);
  if (to.length > 0)
    try {
      if (await email(d, to, e, url)) reached = true;
    } catch (err) {
      console.error('[tickets] staff email failed', err instanceof Error ? err.message : err);
    }
  return reached;
}

/** The organisation's own Teams, webhook and email channels. Returns how many were reached. */
export async function notifyOrg(
  db: NotifyDb,
  e: TicketEvent,
  d: NotifyDeps = realDeps(),
): Promise<number> {
  const channels = await db.alertChannel.findMany({ where: { orgId: e.orgId, enabled: true } });
  const url = portalLink(e.orgId, `/tickets/${e.ticket.id}`, d.env);
  let sent = 0;
  for (const c of channels) {
    const cfg = (c.config ?? {}) as { url?: string; secret?: string; to?: unknown };
    try {
      if (c.type === 'email') {
        const to = Array.isArray(cfg.to) ? parseAddresses(cfg.to.join(',')) : [];
        if (await email(d, to, e, url)) sent++;
      } else if ((c.type === 'teams' || c.type === 'webhook') && cfg.url) {
        await post(d, cfg.url, body(e, url), c.type === 'webhook' ? cfg.secret : undefined);
        sent++;
      }
    } catch (err) {
      console.error(
        '[tickets] organisation notification failed',
        err instanceof Error ? err.message : err,
      );
    }
  }
  return sent;
}
