// Where a "sign up as a service provider" link sends people once their email is confirmed.
export const PROVIDER_NEXT = '/onboarding?as=provider';

// Only allow same-site relative redirects (blocks open redirects like //evil.com or https://...).
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\'))
    return fallback;
  return next;
}
