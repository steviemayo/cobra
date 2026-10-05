import { afterEach, describe, expect, it } from 'vitest';
import { localIso } from './log';

const original = process.env.TZ;
afterEach(() => {
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

describe('localIso', () => {
  const at = new Date('2026-10-05T20:48:34.468Z');

  it('writes the gateway’s own time with its offset', () => {
    process.env.TZ = 'Australia/Sydney';
    // Early October is daylight time in Sydney: UTC+11.
    expect(localIso(at)).toBe('2026-10-06T07:48:34.468+11:00');
    process.env.TZ = 'Australia/Brisbane';
    expect(localIso(at)).toBe('2026-10-06T06:48:34.468+10:00');
  });

  it('keeps the same instant, so it still sorts and parses', () => {
    process.env.TZ = 'Australia/Adelaide';
    expect(Date.parse(localIso(at))).toBe(at.getTime());
    process.env.TZ = 'America/St_Johns';
    expect(localIso(at)).toBe('2026-10-05T18:18:34.468-02:30');
    expect(Date.parse(localIso(at))).toBe(at.getTime());
  });

  it('says Z when the zone is UTC', () => {
    process.env.TZ = 'UTC';
    expect(localIso(at)).toBe('2026-10-05T20:48:34.468Z');
  });
});
