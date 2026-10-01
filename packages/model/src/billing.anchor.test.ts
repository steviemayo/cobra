import { describe, expect, it } from 'vitest';
import { BILLING_INTERVALS, nextFirstOfMonthUnix, nextFirstOfMonthUtc } from './billing';

describe('first of the month anchor', () => {
  const at = (s: string) => nextFirstOfMonthUtc(new Date(s)).toISOString();
  it('lists the intervals', () => expect([...BILLING_INTERVALS]).toEqual(['month', 'year']));
  it('is the 1st of next month at 00:00 UTC', () => {
    expect(at('2026-10-15T13:45:00Z')).toBe('2026-11-01T00:00:00.000Z');
    expect(at('2026-10-31T23:59:59Z')).toBe('2026-11-01T00:00:00.000Z');
  });
  it('is strictly in the future, even exactly on the 1st at midnight', () => {
    expect(at('2026-10-01T00:00:00Z')).toBe('2026-11-01T00:00:00.000Z');
  });
  it('rolls December into January', () => {
    expect(at('2026-12-20T00:00:00Z')).toBe('2027-01-01T00:00:00.000Z');
  });
  it('handles leap February', () => {
    expect(at('2028-02-29T12:00:00Z')).toBe('2028-03-01T00:00:00.000Z');
    expect(at('2027-02-28T12:00:00Z')).toBe('2027-03-01T00:00:00.000Z');
  });
  it('gives the Unix seconds', () => {
    expect(nextFirstOfMonthUnix(new Date('2026-10-15T00:00:00Z'))).toBe(
      Date.UTC(2026, 10, 1) / 1000,
    );
  });
});
