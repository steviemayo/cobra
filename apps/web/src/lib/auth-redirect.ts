// Where a "sign up as a service provider" link sends people once their email is confirmed.
export const PROVIDER_NEXT = '/onboarding?as=provider';

// A fixed, unreachable base to resolve `next` against: only its own origin can ever match, so
// anything that would leave it (a scheme, a host, `//`) fails the origin check below.
const SANDBOX_ORIGIN = 'https://kestrel-safe-next.invalid';

/**
 * Only allow a same-site relative redirect. Rejects an absolute URL, a protocol-relative one
 * (`//evil.com`), a backslash (browsers treat it like `/`, so `/\evil.com` is host-relative), and
 * control characters (tab, newline, carriage return), which the URL parser strips from anywhere in
 * the string before resolving it — `new URL('/\t/evil.com', origin).href` is `https://evil.com/`,
 * not a path on this site. Validated by resolving it, not by pattern-matching the raw text, so a
 * browser or the URL parser cannot read it differently than this function did.
 */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(next))
    return fallback;
  let url: URL;
  try {
    url = new URL(next, SANDBOX_ORIGIN);
  } catch {
    return fallback;
  }
  return url.origin === SANDBOX_ORIGIN ? `${url.pathname}${url.search}${url.hash}` : fallback;
}
