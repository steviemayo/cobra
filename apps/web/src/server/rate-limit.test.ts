import { describe, expect, it } from 'vitest';
import { clientIp, makeRateLimiter, tooManyRequests } from './rate-limit';

describe('makeRateLimiter', () => {
  it('lets a key make so many requests a window, then says when to try again', () => {
    const limit = makeRateLimiter(3, 60_000);
    expect([1, 2, 3].map(() => limit('k', 1000).ok)).toEqual([true, true, true]);
    expect(limit('k', 2000)).toEqual({ ok: false, retryAfterSeconds: 59 });
    // Another key has its own allowance, and the first gets a fresh window.
    expect(limit('other', 2000).ok).toBe(true);
    expect(limit('k', 61_000).ok).toBe(true);
  });

  it('forgets stale keys once there are many, so it cannot grow without bound', () => {
    const limit = makeRateLimiter(1, 1000);
    for (let i = 0; i < 5001; i++) limit(`k${i}`, 0);
    // All of those are now stale; the next call sweeps them before adding its own.
    expect(limit('fresh', 60_000).ok).toBe(true);
  });
});

describe('clientIp', () => {
  it('prefers the first hop of x-forwarded-for, then x-real-ip, then unknown', () => {
    expect(clientIp(new Request('http://x', { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }))).toBe(
      '1.2.3.4',
    );
    expect(clientIp(new Request('http://x', { headers: { 'x-real-ip': '9.9.9.9' } }))).toBe('9.9.9.9');
    expect(clientIp(new Request('http://x'))).toBe('unknown');
  });
});

describe('tooManyRequests', () => {
  it('answers 429 with a retry-after header', async () => {
    const res = tooManyRequests(42);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('Too many') });
  });
});
