import { describe, expect, it } from 'vitest';
import { bestMspRole, effectiveMspRole, grantTakesTickets, mspFromRoute, mspRoute } from './msp';

describe('what a provider’s people can do in a customer', () => {
  it('is the lower of their role in the provider and what the grant allows', () => {
    expect(effectiveMspRole('owner', 'manage')).toBe('dev');
    expect(effectiveMspRole('dev', 'manage')).toBe('dev');
    expect(effectiveMspRole('support', 'manage')).toBe('support');
    expect(effectiveMspRole('customer_viewer', 'manage')).toBe('customer_viewer');
    expect(effectiveMspRole('owner', 'support')).toBe('support');
    expect(effectiveMspRole('dev', 'support')).toBe('support');
    expect(effectiveMspRole('support', 'support')).toBe('support');
    expect(effectiveMspRole('owner', 'view')).toBe('customer_viewer');
    expect(effectiveMspRole('support', 'view')).toBe('customer_viewer');
  });

  it('is never owner, whatever the provider’s role', () => {
    for (const g of ['manage', 'support', 'view'] as const)
      expect(effectiveMspRole('owner', g)).not.toBe('owner');
  });

  it('takes the best across several grants, and nothing without one', () => {
    expect(bestMspRole([])).toBeNull();
    expect(
      bestMspRole([
        { memberRole: 'owner', grant: 'view' },
        { memberRole: 'owner', grant: 'manage' },
      ]),
    ).toBe('dev');
    expect(bestMspRole([{ memberRole: 'support', grant: 'manage' }])).toBe('support');
  });

  it('a view-only provider does not take tickets', () => {
    expect(grantTakesTickets('manage')).toBe(true);
    expect(grantTakesTickets('support')).toBe(true);
    expect(grantTakesTickets('view')).toBe(false);
  });

  it('routes tickets to a provider by a prefixed id, and reads it back', () => {
    expect(mspRoute('abc')).toBe('msp:abc');
    expect(mspFromRoute('msp:abc')).toBe('abc');
    expect(mspFromRoute('org')).toBeNull();
    expect(mspFromRoute('kestrel')).toBeNull();
  });
});
