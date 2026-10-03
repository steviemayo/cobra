import type { PrismaClient } from '@kestrel/db';
import { portalLink } from './alerts';
import { pinnedFetch, postSigned, type Lookup } from './outbound';
import { parseAddresses, sendEmail } from './resend';

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
      await postSigned(d, hook, body(e, url));
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

/**
 * Tells Kestrel staff an organisation asked to pay by invoice, on the same staff channels as tickets
 * (STAFF_TICKET_WEBHOOK_URL, STAFF_TICKET_EMAIL). Best effort. True if at least one was reached.
 */
export async function notifyInvoiceRequest(
  e: { orgId: string; orgName: string; note?: string },
  d: NotifyDeps = realDeps(),
): Promise<boolean> {
  const base = d.env.NEXT_PUBLIC_APP_URL;
  const url = base ? `${base}/staff/invoices` : null;
  const note = snip(e.note);
  const text = [`${e.orgName} asked to pay by invoice instead of card`, note, url]
    .filter(Boolean)
    .join('\n');
  let reached = false;
  const hook = d.env.STAFF_TICKET_WEBHOOK_URL;
  if (hook)
    try {
      await postSigned(d, hook, {
        text,
        event: 'billing.invoice_request',
        organisation: { id: e.orgId, name: e.orgName },
        note,
        url,
      });
      reached = true;
    } catch (err) {
      console.error(
        '[billing] staff notification failed',
        err instanceof Error ? err.message : err,
      );
    }
  const to = parseAddresses(d.env.STAFF_TICKET_EMAIL);
  if (to.length > 0)
    try {
      if (await sendEmail(d, to, `[Kestrel] Invoice billing request: ${e.orgName}`, text))
        reached = true;
    } catch (err) {
      console.error('[billing] staff email failed', err instanceof Error ? err.message : err);
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
        await postSigned(d, cfg.url, body(e, url), c.type === 'webhook' ? cfg.secret : undefined);
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
