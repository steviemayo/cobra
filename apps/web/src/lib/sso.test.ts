import { describe, expect, it } from 'vitest';
import { ssoDomain, ssoErrorMessage, ssoRedirect } from './sso';

describe('the company domain of an email', () => {
  it('takes the part after the @, in lower case', () => {
    expect(ssoDomain('Alex@Example.COM')).toBe('example.com');
    expect(ssoDomain('  a@corp.example.co.uk ')).toBe('corp.example.co.uk');
    expect(ssoDomain('a@sub-domain.example.org')).toBe('sub-domain.example.org');
  });

  it('is null for anything that is not a plain work email', () => {
    for (const bad of ['', 'nobody', '@example.com', 'a@', 'a@localhost', 'a@example', 'a@exa mple.com', 'a@b@example.com', 'a@example.com/path', 'a@-bad.com', 'a@example.c', 'a@.example.com', 'a@example..com'])
      expect(ssoDomain(bad)).toBeNull();
  });
});

describe('what to say when sign-in cannot start', () => {
  it('explains a company that has no single sign-on', () => {
    expect(ssoErrorMessage('No SSO provider assigned for this domain')).toMatch(/not set up for that email/);
    expect(ssoErrorMessage('SSO provider not found')).toMatch(/not set up/);
  });
  it('explains single sign-on not being turned on', () => {
    expect(ssoErrorMessage('SAML 2.0 is disabled on this instance')).toMatch(/not turned on/);
  });
  it('gives a plain message for anything else, never the raw error', () => {
    const text = ssoErrorMessage('ECONNRESET at 10.0.0.1');
    expect(text).toMatch(/could not start/);
    expect(text).not.toContain('ECONNRESET');
    expect(ssoErrorMessage(undefined)).toMatch(/could not start/);
  });
});

describe('where the identity provider sends people back', () => {
  it('goes to the auth callback, keeping the page they wanted', () => {
    expect(ssoRedirect('https://app.example', '/')).toBe('https://app.example/auth/callback');
    expect(ssoRedirect('https://app.example', '/o/1/rooms')).toBe('https://app.example/auth/callback?next=%2Fo%2F1%2Frooms');
  });
});
