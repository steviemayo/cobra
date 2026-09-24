import { describe, expect, it } from 'vitest';
import { cronAuthorised } from './cron-auth';

const req = (auth?: string) =>
  new Request('https://x.test/api/cron', { headers: auth ? { authorization: auth } : {} });
const SECRET = 'a-long-enough-cron-secret';

describe('cron authorisation', () => {
  it('accepts only the exact secret', () => {
    expect(cronAuthorised(req(`Bearer ${SECRET}`), SECRET)).toBe(true);
    expect(cronAuthorised(req(`Bearer ${SECRET}x`), SECRET)).toBe(false);
    expect(cronAuthorised(req('Bearer nope'), SECRET)).toBe(false);
    expect(cronAuthorised(req(SECRET), SECRET)).toBe(false);
    expect(cronAuthorised(req(), SECRET)).toBe(false);
  });

  it('lets nobody in when no usable secret is configured', () => {
    expect(cronAuthorised(req('Bearer '), '')).toBe(false);
    expect(cronAuthorised(req('Bearer short'), 'short')).toBe(false);
    expect(cronAuthorised(req('Bearer undefined'), undefined)).toBe(false);
  });
});
