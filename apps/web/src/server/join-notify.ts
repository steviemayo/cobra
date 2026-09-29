import type { PrismaClient } from '@kestrel/db';
import { portalLink } from './alerts';
import { postSigned } from './outbound';
import { parseAddresses, sendEmail } from './resend';
import { realDeps, type NotifyDeps } from './ticket-notify';

// Tells an organisation's owners that someone from their company asked to join. Through the
// organisation's own Teams, webhook and email channels, and by email straight to each owner (an
// email needs RESEND_API_KEY and ALERT_FROM_EMAIL on the server; without them it is quietly
// skipped, and the request still shows on the Team page). Best effort: a failed notification never
// fails the request that caused it, so callers run this after responding.
export type JoinNotifyDb = Pick<PrismaClient, 'alertChannel' | 'member'>;

export interface JoinRequestEvent {
  orgId: string;
  orgName: string;
  requesterEmail: string;
}

function message(e: JoinRequestEvent, url: string | null) {
  const headline = `${e.requesterEmail} (same company email domain) asked to join ${e.orgName} on Kestrel`;
  return {
    headline,
    // Teams incoming webhooks show `text`; everything else reads the structured fields.
    text: [headline, 'Approve or decline it under Team.', url].filter(Boolean).join('\n'),
  };
}

/** Returns how many channels and owners were reached. */
export async function notifyJoinRequest(
  db: JoinNotifyDb,
  e: JoinRequestEvent,
  d: NotifyDeps = realDeps(),
): Promise<number> {
  const url = portalLink(e.orgId, '/team', d.env);
  const { headline, text } = message(e, url);
  let sent = 0;

  const channels = await db.alertChannel.findMany({ where: { orgId: e.orgId, enabled: true } });
  for (const c of channels) {
    const cfg = (c.config ?? {}) as { url?: string; secret?: string; to?: unknown };
    try {
      if (c.type === 'email') {
        const to = Array.isArray(cfg.to) ? parseAddresses(cfg.to.join(',')) : [];
        if (await sendEmail(d, to, `[Kestrel] ${headline}`, text)) sent++;
      } else if ((c.type === 'teams' || c.type === 'webhook') && cfg.url) {
        await postSigned(
          d,
          cfg.url,
          {
            text,
            event: 'member.join_request',
            organisation: { id: e.orgId, name: e.orgName },
            requester: { email: e.requesterEmail },
            url,
          },
          c.type === 'webhook' ? cfg.secret : undefined,
        );
        sent++;
      }
    } catch (err) {
      console.error('[join] channel notification failed', err instanceof Error ? err.message : err);
    }
  }

  const owners = await db.member.findMany({ where: { orgId: e.orgId, role: 'owner' } });
  const to = parseAddresses(owners.map((o) => o.email).filter(Boolean).join(','));
  try {
    if (await sendEmail(d, to, `[Kestrel] ${headline}`, text)) sent++;
  } catch (err) {
    console.error('[join] owner email failed', err instanceof Error ? err.message : err);
  }
  return sent;
}
