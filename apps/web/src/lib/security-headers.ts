// The headers every response carries: no scope for something loaded from elsewhere, no framing,
// no sniffing a response into a different content type. Kept separate from next.config.ts, which
// has no test of its own, so this has one.

export interface SecurityHeader {
  key: string;
  value: string;
}

/**
 * `env.NEXT_PUBLIC_SUPABASE_URL` is added to connect-src, since Supabase Auth is called from the
 * browser. Org branding lets an owner set any logo URL and Supabase's MFA enrolment QR code is a
 * data: image, so img-src stays open to https: and data:. Next's hydration data ships as an inline
 * <script> and Tailwind's arbitrary values as inline style attributes, so both need
 * 'unsafe-inline' for now (a nonce-based policy would remove it; tracked as a later improvement).
 */
export function securityHeaders(env: Record<string, string | undefined> = process.env): SecurityHeader[] {
  const supabaseOrigin = (() => {
    try {
      return new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? '').origin;
    } catch {
      return '';
    }
  })();
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src 'self'${supabaseOrigin ? ` ${supabaseOrigin}` : ''}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
  ].join('; ');
  return [
    { key: 'Content-Security-Policy', value: csp },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'same-origin' },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    },
  ];
}
