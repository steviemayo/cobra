import { generateSecret, hashSecret, open, seal, secretMatches } from '@kestrel/crypto';
import type { PrismaClient } from '@kestrel/db';
import { z } from 'zod';
import { assertPublicUrl, postSigned, type PostDeps } from './outbound';

// Service desk integration (docs/pivot-monitoring.md, "Support"). A connector mirrors tickets to an
// outside system and takes status changes and comments back. Kestrel stays the source of truth for
// the incident; the outside desk owns the ticket's life once linked. Three kinds:
//   webhook  posts signed JSON to any service desk and accepts calls back
//   demo     a built-in stand-in desk, so the round trip can be shown without a real system
//   email_in takes mail forwarded by a mail service and turns it into a ticket
export type ItsmDb = Pick<
  PrismaClient,
  'itsmConnector' | 'itsmLink' | 'itsmSyncLog' | 'ticket' | 'ticketComment' | 'room'
>;

export const CONNECTOR_TYPES = ['webhook', 'demo', 'email_in'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];
export const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;

const secretsKey = () => process.env.KESTREL_SECRETS_KEY || undefined;
type Result<T = { id: string }> = { ok: true; value: T } | { ok: false; message: string };
const bad = (message: string): { ok: false; message: string } => ({ ok: false, message });

/** What outside desks call their statuses, mapped onto Kestrel's four. */
export function mapStatus(external: string): (typeof TICKET_STATUSES)[number] | null {
  const s = external
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if ((TICKET_STATUSES as readonly string[]).includes(s))
    return s as (typeof TICKET_STATUSES)[number];
  if (['new', 'reopened', 'submitted', 'to_do', 'todo'].includes(s)) return 'open';
  if (
    [
      'pending',
      'on_hold',
      'waiting',
      'assigned',
      'work_in_progress',
      'in_review',
      'active',
    ].includes(s)
  )
    return 'in_progress';
  if (['done', 'completed', 'fixed', 'resolved_by_customer'].includes(s)) return 'resolved';
  if (['cancelled', 'canceled', 'rejected', 'duplicate', 'won_t_fix'].includes(s)) return 'closed';
  return null;
}

async function log(
  db: ItsmDb,
  orgId: string,
  connectorId: string,
  entry: { ticketId?: string | null; direction: 'out' | 'in'; ok: boolean; summary: string },
  at = new Date(),
) {
  await db.itsmSyncLog.create({
    data: {
      orgId,
      connectorId,
      ticketId: entry.ticketId ?? null,
      direction: entry.direction,
      ok: entry.ok,
      summary: entry.summary.slice(0, 500),
      at,
    },
  });
}

// ---- Connectors ----------------------------------------------------------------------------------

export async function createConnector(
  db: ItsmDb,
  input: {
    orgId: string;
    name: string;
    type: ConnectorType;
    url?: string | null;
    /** Signs outbound calls. Optional; without it calls are unsigned. */
    secret?: string | null;
    userId: string | null;
  },
  deps?: Pick<PostDeps, 'resolve'>,
): Promise<Result<{ id: string; inboundSecret: string | null }>> {
  const config: Record<string, unknown> = {};
  if (input.type === 'webhook') {
    if (!input.url) return bad('A webhook needs an address');
    try {
      await assertPublicUrl(input.url, deps?.resolve);
    } catch (e) {
      return bad(e instanceof Error ? e.message : 'That address cannot be used');
    }
    config.url = input.url;
  }
  let sealedSecret: string | null = null;
  if (input.secret) {
    const key = secretsKey();
    if (!key) return bad('Storing a signing secret needs KESTREL_SECRETS_KEY on the server');
    sealedSecret = seal(input.secret, key);
  }
  // What the outside system presents when it calls Kestrel. Shown once.
  const inbound = generateSecret(24);
  const row = await db.itsmConnector.create({
    data: {
      orgId: input.orgId,
      name: input.name,
      type: input.type,
      enabled: true,
      config: config as never,
      sealedSecret,
      inboundHash: hashSecret(inbound),
      createdBy: input.userId,
    },
  });
  return { ok: true, value: { id: row.id, inboundSecret: inbound } };
}

export async function setConnectorEnabled(
  db: ItsmDb,
  orgId: string,
  id: string,
  enabled: boolean,
): Promise<Result> {
  const row = await db.itsmConnector.findFirst({ where: { id, orgId } });
  if (!row) return bad('No such connector');
  await db.itsmConnector.update({ where: { id }, data: { enabled } });
  return { ok: true, value: { id } };
}

export async function deleteConnector(db: ItsmDb, orgId: string, id: string): Promise<Result> {
  const row = await db.itsmConnector.findFirst({ where: { id, orgId } });
  if (!row) return bad('No such connector');
  await db.itsmLink.deleteMany({ where: { connectorId: id } });
  await db.itsmSyncLog.deleteMany({ where: { connectorId: id } });
  await db.itsmConnector.delete({ where: { id } });
  return { ok: true, value: { id } };
}

/** A new secret for the outside system to call back with. Shown once. */
export async function rotateInboundSecret(
  db: ItsmDb,
  orgId: string,
  id: string,
): Promise<Result<{ inboundSecret: string }>> {
  const row = await db.itsmConnector.findFirst({ where: { id, orgId } });
  if (!row) return bad('No such connector');
  const inbound = generateSecret(24);
  await db.itsmConnector.update({ where: { id }, data: { inboundHash: hashSecret(inbound) } });
  return { ok: true, value: { inboundSecret: inbound } };
}

// ---- Outbound ------------------------------------------------------------------------------------

type TicketRow = NonNullable<Awaited<ReturnType<ItsmDb['ticket']['findFirst']>>>;
export type MirrorEvent = 'ticket.created' | 'ticket.updated' | 'ticket.comment';

let demoCounter = 1000;

/**
 * Tells every enabled connector about a ticket event. A failure is recorded in the sync log and never
 * thrown, so a slow or broken service desk cannot hold up raising or updating a ticket.
 */
export async function mirrorTicket(
  db: ItsmDb,
  deps: PostDeps,
  ticket: TicketRow,
  event: MirrorEvent,
  comment?: { body: string; author: string | null },
  now = new Date(),
): Promise<void> {
  const connectors = await db.itsmConnector.findMany({
    where: { orgId: ticket.orgId, enabled: true },
  });
  const room = ticket.roomId ? await db.room.findFirst({ where: { id: ticket.roomId } }) : null;
  for (const c of connectors) {
    if (c.type === 'email_in') continue;
    const link = await db.itsmLink.findFirst({ where: { ticketId: ticket.id, connectorId: c.id } });
    try {
      if (c.type === 'demo') {
        // A stand-in desk: it accepts the ticket, gives it a reference, and says so.
        let ref = link?.externalRef;
        if (!ref) {
          ref = `DEMO-${++demoCounter}`;
          await db.itsmLink.create({
            data: {
              orgId: ticket.orgId,
              ticketId: ticket.id,
              connectorId: c.id,
              externalRef: ref,
              lastStatus: ticket.status,
              lastSyncAt: now,
            },
          });
        } else
          await db.itsmLink.updateMany({
            where: { ticketId: ticket.id, connectorId: c.id },
            data: { lastStatus: ticket.status, lastSyncAt: now },
          });
        await log(
          db,
          ticket.orgId,
          c.id,
          {
            ticketId: ticket.id,
            direction: 'out',
            ok: true,
            summary: `${event} sent to the demo desk as ${ref}`,
          },
          now,
        );
        continue;
      }
      const cfg = (c.config ?? {}) as { url?: string };
      if (!cfg.url) throw new Error('No address is set');
      const secret =
        c.sealedSecret && secretsKey() ? open(c.sealedSecret, secretsKey()!) : undefined;
      await postSigned(
        deps,
        cfg.url,
        {
          event,
          ticket: {
            id: ticket.id,
            title: ticket.title,
            body: ticket.body,
            status: ticket.status,
            priority: ticket.priority,
            routedTo: ticket.routedTo,
            room: room?.name ?? null,
            deviceId: ticket.deviceId,
            incidentId: ticket.incidentId,
            createdAt: ticket.createdAt.toISOString(),
          },
          externalRef: link?.externalRef ?? null,
          ...(comment ? { comment } : {}),
        },
        secret,
      );
      await log(
        db,
        ticket.orgId,
        c.id,
        { ticketId: ticket.id, direction: 'out', ok: true, summary: `${event} sent` },
        now,
      );
    } catch (e) {
      await log(
        db,
        ticket.orgId,
        c.id,
        {
          ticketId: ticket.id,
          direction: 'out',
          ok: false,
          summary: `${event} failed: ${e instanceof Error ? e.message : String(e)}`,
        },
        now,
      );
    }
  }
}

// ---- Inbound -------------------------------------------------------------------------------------

export const InboundBody = z.object({
  ticketId: z.string().uuid().optional(),
  externalRef: z.string().min(1).max(100).optional(),
  status: z.string().max(40).optional(),
  comment: z.string().max(5000).optional(),
  author: z.string().max(100).optional(),
});

async function connectorFor(db: ItsmDb, id: string, secret: string) {
  const c = await db.itsmConnector.findFirst({ where: { id } });
  if (!c || !c.enabled || !c.inboundHash || !secretMatches(secret, c.inboundHash)) return null;
  return c;
}

/** The outside desk says something about a ticket: link it, change its status, add a comment. */
export async function handleInbound(
  db: ItsmDb,
  input: { connectorId: string; secret: string; body: unknown },
  now = new Date(),
): Promise<Result<{ ticketId: string }>> {
  const c = await connectorFor(db, input.connectorId, input.secret);
  if (!c) return bad('Not allowed');
  const parsed = InboundBody.safeParse(input.body);
  if (!parsed.success) {
    await log(
      db,
      c.orgId,
      c.id,
      { direction: 'in', ok: false, summary: 'Unreadable message' },
      now,
    );
    return bad('That message is not valid');
  }
  const b = parsed.data;
  let ticket = b.ticketId
    ? await db.ticket.findFirst({ where: { id: b.ticketId, orgId: c.orgId } })
    : null;
  if (!ticket && b.externalRef) {
    const link = await db.itsmLink.findFirst({
      where: { connectorId: c.id, externalRef: b.externalRef },
    });
    if (link) ticket = await db.ticket.findFirst({ where: { id: link.ticketId, orgId: c.orgId } });
  }
  if (!ticket) {
    await log(
      db,
      c.orgId,
      c.id,
      { direction: 'in', ok: false, summary: 'No matching ticket' },
      now,
    );
    return bad('No matching ticket');
  }
  // Remember which outside ticket this is, the first time both are given.
  if (
    b.ticketId &&
    b.externalRef &&
    !(await db.itsmLink.findFirst({ where: { ticketId: ticket.id, connectorId: c.id } }))
  )
    await db.itsmLink.create({
      data: {
        orgId: c.orgId,
        ticketId: ticket.id,
        connectorId: c.id,
        externalRef: b.externalRef,
        lastSyncAt: now,
      },
    });
  const notes: string[] = [];
  if (b.status) {
    const next = mapStatus(b.status);
    if (!next) notes.push(`status "${b.status}" not understood`);
    else if (next !== ticket.status) {
      const done = next === 'resolved' || next === 'closed';
      await db.ticket.update({
        where: { id: ticket.id },
        data: { status: next, closedAt: done ? (ticket.closedAt ?? now) : null },
      });
      notes.push(`status ${next}`);
    }
  }
  if (b.comment) {
    await db.ticketComment.create({
      data: {
        orgId: c.orgId,
        ticketId: ticket.id,
        body: `${b.author ? `${b.author}: ` : ''}${b.comment}`,
        visibility: 'public',
        fromStaff: false,
        createdAt: now,
      },
    });
    notes.push('comment added');
  }
  await db.itsmLink.updateMany({
    where: { ticketId: ticket.id, connectorId: c.id },
    data: { lastStatus: b.status ?? null, lastSyncAt: now },
  });
  await log(
    db,
    c.orgId,
    c.id,
    { ticketId: ticket.id, direction: 'in', ok: true, summary: notes.join(', ') || 'linked' },
    now,
  );
  return { ok: true, value: { ticketId: ticket.id } };
}

export const MailBody = z.object({
  from: z.string().max(200),
  subject: z.string().min(1).max(150),
  text: z.string().max(10_000).default(''),
});

/** A mail forwarded by a mail service becomes a ticket from that sender. */
export async function handleEmailIn(
  db: ItsmDb,
  input: { connectorId: string; secret: string; body: unknown },
  now = new Date(),
): Promise<Result<{ ticketId: string }>> {
  const c = await connectorFor(db, input.connectorId, input.secret);
  if (!c || c.type !== 'email_in') return bad('Not allowed');
  const parsed = MailBody.safeParse(input.body);
  if (!parsed.success) {
    await log(db, c.orgId, c.id, { direction: 'in', ok: false, summary: 'Unreadable mail' }, now);
    return bad('That mail is not valid');
  }
  const m = parsed.data;
  const ticket = await db.ticket.create({
    data: {
      orgId: c.orgId,
      title: m.subject,
      body: m.text.trim() || m.subject,
      status: 'open',
      createdByEmail: m.from,
      priority: 'normal',
      routedTo: 'org',
      createdAt: now,
    },
  });
  await log(
    db,
    c.orgId,
    c.id,
    {
      ticketId: ticket.id,
      direction: 'in',
      ok: true,
      summary: `Ticket raised from mail by ${m.from}`,
    },
    now,
  );
  return { ok: true, value: { ticketId: ticket.id } };
}

/**
 * For the demo desk only: acts as the outside desk answering, so the portal can show the round trip
 * without a real system. Goes through the same inbound path as a real desk.
 */
export async function simulateDemoReply(
  db: ItsmDb,
  input: {
    orgId: string;
    connectorId: string;
    ticketId: string;
    action: 'work' | 'resolve' | 'comment';
  },
  now = new Date(),
): Promise<Result<{ ticketId: string }>> {
  const c = await db.itsmConnector.findFirst({
    where: { id: input.connectorId, orgId: input.orgId },
  });
  if (!c || c.type !== 'demo') return bad('Only the demo desk can do this');
  const link = await db.itsmLink.findFirst({
    where: { ticketId: input.ticketId, connectorId: c.id },
  });
  if (!link) return bad('That ticket has not been sent to the demo desk');
  const secret = generateSecret(24);
  await db.itsmConnector.update({ where: { id: c.id }, data: { inboundHash: hashSecret(secret) } });
  const body =
    input.action === 'work'
      ? {
          externalRef: link.externalRef,
          status: 'Work in progress',
          comment: 'We are looking into this.',
          author: 'Demo desk',
        }
      : input.action === 'resolve'
        ? {
            externalRef: link.externalRef,
            status: 'Resolved',
            comment: 'Fixed and confirmed.',
            author: 'Demo desk',
          }
        : {
            externalRef: link.externalRef,
            comment: 'Could you tell us when it last worked?',
            author: 'Demo desk',
          };
  return handleInbound(db, { connectorId: c.id, secret, body }, now);
}
