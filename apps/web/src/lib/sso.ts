// Single sign-on helpers. The sign-in itself is Supabase Auth's (SAML or OIDC, set up per company
// domain in Supabase; see docs/sso.md). These are the small pure parts around it.

/** The company domain of a work email ("a@Example.com" gives "example.com"), or null if it is not one. */
export function ssoDomain(input: string): string | null {
  const email = input.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 1 || email.indexOf('@') !== at) return null;
  const domain = email.slice(at + 1);
  // A real domain: labels of letters, digits and hyphens, at least one dot, no spaces or paths.
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) return null;
  return domain;
}

/** What to tell someone when single sign-on could not start. */
export function ssoErrorMessage(message: string | undefined): string {
  if (message && /no sso provider|provider.*not found|domain.*not/i.test(message))
    return 'Single sign-on is not set up for that email’s company. Ask your administrator, or sign in with your password.';
  if (message && /sso.*(disabled|not enabled|not supported)|saml.*(disabled|not enabled)/i.test(message))
    return 'Single sign-on is not turned on for Kestrel yet.';
  return 'Single sign-on could not start. Try again, or sign in with your password.';
}

/** Where the identity provider sends the person back to, carrying the page they were heading for. */
export function ssoRedirect(origin: string, next: string): string {
  return `${origin}/auth/callback${next && next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`;
}
