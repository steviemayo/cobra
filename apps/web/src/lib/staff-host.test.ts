import { describe, expect, it } from 'vitest';
import { staffHostVerdict } from './staff-host';

describe('where the staff portal is served', () => {
  it('anywhere, when no staff host is set', () => {
    expect(staffHostVerdict('app.example.com', '/staff/orgs', undefined)).toBe('ok');
    expect(staffHostVerdict('admin.example.com', '/o/1', undefined)).toBe('ok');
  });

  it('only on the staff host, once one is set', () => {
    expect(staffHostVerdict('app.example.com', '/staff/orgs', 'admin.example.com')).toBe(
      'not-found',
    );
    expect(staffHostVerdict('app.example.com', '/staff', 'admin.example.com')).toBe('not-found');
    expect(staffHostVerdict('admin.example.com', '/staff/orgs', 'admin.example.com')).toBe('ok');
  });

  it('ignores the port and letter case', () => {
    expect(staffHostVerdict('ADMIN.example.com:3000', '/staff', 'admin.example.com')).toBe('ok');
  });

  it('the staff host serves only staff, sign-in and API routes', () => {
    const v = (p: string) => staffHostVerdict('admin.example.com', p, 'admin.example.com');
    expect(v('/o/abc')).toBe('to-staff');
    expect(v('/')).toBe('to-staff');
    expect(v('/login')).toBe('ok');
    expect(v('/auth/callback')).toBe('ok');
    expect(v('/api/trpc/staff.me')).toBe('ok');
  });

  it('a path that only starts with the word staff is not a staff path', () => {
    expect(staffHostVerdict('app.example.com', '/staffing', 'admin.example.com')).toBe('ok');
  });
});
