import { describe, expect, it } from 'vitest';
import { safeNext } from './auth-redirect';
import { describeAudit } from './audit-text';
import { plural, timeAgo } from './format';

describe('safeNext', () => {
  it('keeps same-site relative paths', () => {
    expect(safeNext('/o/abc/rooms?x=1')).toBe('/o/abc/rooms?x=1');
    expect(safeNext('/invite/token')).toBe('/invite/token');
  });

  it('rejects open-redirect attempts and empty values', () => {
    for (const bad of [
      'https://evil.com',
      '//evil.com',
      '/\\evil.com',
      'evil.com',
      '',
      null,
      undefined,
      '/\t/evil.com',
      '/\n/evil.com',
      '/\r/evil.com',
      '/\u0000/evil.com',
      '/\t\tevil.com',
    ])
      expect(safeNext(bad), String(bad)).toBe('/');
  });

  it('keeps the query and hash of a same-site path', () => {
    expect(safeNext('/o/abc/rooms?x=1#y')).toBe('/o/abc/rooms?x=1#y');
  });

  it('does not confuse an ordinary path for an open redirect just because it looks like one', () => {
    // These stay on our own origin as literal path segments; they are not bypasses.
    expect(safeNext('/@evil.com')).toBe('/@evil.com');
    expect(safeNext('/.evil.com')).toBe('/.evil.com');
    expect(safeNext('/%09/evil.com')).toBe('/%09/evil.com');
  });

  it('uses the given fallback', () => {
    expect(safeNext('//x', '/login')).toBe('/login');
  });
});

describe('describeAudit', () => {
  it('words deployments, including rollbacks', () => {
    expect(describeAudit('deployment.create', { room: 'Boardroom', number: 3, kind: 'deploy' })).toBe(
      'deployed release 3 to “Boardroom”',
    );
    expect(describeAudit('deployment.create', { room: 'Boardroom', number: 2, kind: 'rollback' })).toBe(
      'rolled “Boardroom” back to release 2',
    );
    expect(describeAudit('deployment.schedule', { room: 'Boardroom', number: 4 })).toBe(
      'scheduled release 4 for “Boardroom”',
    );
  });

  it('words known actions in plain language', () => {
    expect(describeAudit('room.create', { name: 'Boardroom', site: 'HQ' })).toBe(
      'created room “Boardroom” in HQ',
    );
    expect(describeAudit('member.role', { email: 'a@b.co', from: 'dev', to: 'owner' })).toBe(
      'changed a@b.co from Developer to Owner',
    );
  });

  it('falls back to the raw action for unknown ones', () => {
    expect(describeAudit('thing.happened', {})).toBe('thing.happened');
  });
});

describe('format helpers', () => {
  it('pluralises', () => {
    expect(plural(1, 'room')).toBe('1 room');
    expect(plural(3, 'room')).toBe('3 rooms');
  });

  it('formats relative time', () => {
    expect(timeAgo(new Date())).toBe('just now');
    expect(timeAgo(new Date(Date.now() - 2 * 3_600_000))).toBe('2 hours ago');
  });
});
