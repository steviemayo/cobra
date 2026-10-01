import { describe, expect, it } from 'vitest';
import { securityHeaders } from './security-headers';

function csp(env: Record<string, string | undefined> = {}) {
  return securityHeaders(env).find((h) => h.key === 'Content-Security-Policy')!.value;
}

describe('security headers', () => {
  it('closes what a page can load, be framed by, or navigate to, by default', () => {
    const value = csp();
    expect(value).toContain("default-src 'self'");
    expect(value).toContain("object-src 'none'");
    expect(value).toContain("base-uri 'none'");
    expect(value).toContain("frame-ancestors 'none'");
    expect(value).toContain("frame-src 'none'");
    expect(value).toContain("form-action 'self'");
  });

  it('adds the Supabase origin to connect-src so Auth calls from the browser are not blocked', () => {
    expect(csp({ NEXT_PUBLIC_SUPABASE_URL: 'https://abcxyz.supabase.co' })).toContain(
      "connect-src 'self' https://abcxyz.supabase.co",
    );
  });

  it('never breaks on a missing or malformed Supabase URL', () => {
    expect(csp({})).toContain("connect-src 'self'");
    expect(csp({ NEXT_PUBLIC_SUPABASE_URL: 'not a url' })).toContain("connect-src 'self'");
  });

  it('sets the other headers that stop framing and sniffing', () => {
    const headers = Object.fromEntries(securityHeaders().map((h) => [h.key, h.value]));
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('same-origin');
    expect(headers['Permissions-Policy']).toContain('camera=()');
  });
});
