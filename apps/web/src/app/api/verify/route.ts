import { PM_REPORT_PURPOSE, REGISTER_PURPOSE, checkDocument } from '@/server/register-issues';
import { trustedPublicKeys } from '@/server/signing';
import { clientIp, makeRateLimiter, tooManyRequests } from '@/server/rate-limit';

export const dynamic = 'force-dynamic';

const byAddress = makeRateLimiter(30, 60_000);

// Anyone holding a signed document (an asset register or maintenance report) can check it here. Nothing
// is stored: the document is checked against the keys Kestrel signs with and the result is returned.
export async function POST(req: Request) {
  const limit = byAddress(clientIp(req));
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
  const text = await req.text();
  if (text.length > 20_000_000)
    return Response.json({ error: 'That is too large' }, { status: 413 });
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return Response.json({ valid: false, reason: 'malformed' }, { status: 400 });
  }
  const purpose = (doc as { purpose?: string } | null)?.purpose;
  const which = purpose === PM_REPORT_PURPOSE ? PM_REPORT_PURPOSE : REGISTER_PURPOSE;
  return Response.json(checkDocument(doc, which, trustedPublicKeys()));
}
