// Sending plain text email through Resend: alerts, ticket notifications, join requests and monthly
// reports all go through here, so the RESEND_API_KEY/ALERT_FROM_EMAIL check, the recipient cap and
// the subject sanitisation (a bare defence against header injection from a title or name a user
// typed) live once.
export interface EmailDeps {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
}
export const realEmailDeps = (): EmailDeps => ({ fetch, env: process.env });

const ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
export const MAX_RECIPIENTS = 10;

/** Addresses from a comma or semicolon separated list, keeping only well-formed ones. */
export function parseAddresses(list: string | undefined): string[] {
  return [
    ...new Set(
      (list ?? '')
        .split(/[,;]/)
        .map((a) => a.trim())
        .filter((a) => ADDRESS.test(a)),
    ),
  ].slice(0, MAX_RECIPIENTS);
}

export function emailConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.RESEND_API_KEY && !!env.ALERT_FROM_EMAIL;
}

/**
 * Sends a plain text email through Resend. Returns false (without trying) when the server has no
 * email settings, so a Kestrel that has not set up its sending domain simply does not send.
 */
export async function sendEmail(
  d: EmailDeps,
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
