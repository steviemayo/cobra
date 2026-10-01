import { describe, expect, it } from 'vitest';
import { formatInZone, knownZone } from './time';

describe('times in a site’s zone', () => {
  const utc = '2026-10-01T02:53:00.904Z';

  it('reads the time from the screenshot as about 12:53 pm Sydney time, with the zone named', () => {
    // 1 Oct 2026 is after daylight saving starts on 4 Oct? No: it starts the first Sunday, 4 Oct, so this is AEST.
    expect(formatInZone(utc, 'Australia/Sydney')).toBe('1 Oct 2026, 12:53 pm AEST');
  });

  it('follows daylight saving', () => {
    expect(formatInZone('2026-10-10T02:00:00Z', 'Australia/Sydney')).toBe('10 Oct 2026, 1:00 pm AEDT');
  });

  it('uses the site’s zone, not the server’s', () => {
    expect(formatInZone(utc, 'Australia/Perth')).toBe('1 Oct 2026, 10:53 am AWST');
    expect(formatInZone(utc, 'America/New_York')).toMatch(/^30 Sept? 2026, 10:53 pm (EDT|GMT-4)$/);
  });

  it('can leave out the date, the time or this year', () => {
    expect(formatInZone(utc, 'Australia/Sydney', { timeOnly: true })).toBe('12:53 pm AEST');
    expect(formatInZone(utc, 'Australia/Sydney', { dateOnly: true })).toBe('1 Oct 2026');
    const now = Date.parse('2026-12-01T00:00:00Z');
    expect(formatInZone(utc, 'Australia/Sydney', { shortYear: true }, now)).toBe('1 Oct, 12:53 pm AEST');
    expect(formatInZone('2025-10-01T02:53:00Z', 'Australia/Sydney', { shortYear: true }, now)).toBe(
      '1 Oct 2025, 12:53 pm AEST',
    );
  });

  it('falls back to Sydney on the server for a zone that is missing or unknown, and ignores a bad date', () => {
    expect(formatInZone(utc, null)).toBe('1 Oct 2026, 12:53 pm AEST');
    expect(formatInZone(utc, 'Not/AZone')).toBe('1 Oct 2026, 12:53 pm AEST');
    expect(formatInZone('nonsense', 'Australia/Sydney')).toBe('');
    expect(knownZone('Australia/Sydney')).toBe(true);
    expect(knownZone('Mars/Olympus')).toBe(false);
  });
});
