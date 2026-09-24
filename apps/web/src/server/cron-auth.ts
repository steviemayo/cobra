import { timingSafeEqual } from 'node:crypto';

/** Scheduled jobs must present CRON_SECRET. With no secret configured, nothing is allowed in. */
export function cronAuthorised(req: Request, secret = process.env.CRON_SECRET): boolean {
  if (!secret || secret.length < 16) return false;
  const given = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
