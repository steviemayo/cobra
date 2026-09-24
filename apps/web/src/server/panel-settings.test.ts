import { describe, expect, it } from 'vitest';
import { verifyPin } from '@kestrel/crypto';
import { PanelBranding } from '@kestrel/model';
import { PanelInput, applyPanelInput, publicPanel, readPanel } from './panel-settings';

const branding = () => PanelBranding.parse({});
const input = (over: Partial<PanelInput> = {}): PanelInput => ({
  mode: 'open',
  trustedIps: [],
  branding: branding(),
  ...over,
});

describe('readPanel', () => {
  it('defaults to open access and dark branding', () => {
    for (const raw of [null, undefined, {}, 'garbage', 42, { access: { mode: 'nonsense' } }]) {
      const p = readPanel(raw);
      expect(p.access).toMatchObject({ mode: 'open', trustedIps: [] });
      expect(p.branding.mode).toBe('dark');
    }
  });
});

describe('publicPanel', () => {
  it('never exposes the PIN hash', () => {
    const p = applyPanelInput(readPanel(null), input({ mode: 'pin', pin: '4821' }));
    const pub = publicPanel(p);
    expect(pub).toMatchObject({ mode: 'pin', hasPin: true });
    expect(JSON.stringify(pub)).not.toContain(p.access.pinHash!);
    expect(JSON.stringify(pub)).not.toContain('pinHash');
  });
});

describe('applyPanelInput', () => {
  it('requires a PIN to switch PIN mode on', () => {
    expect(() => applyPanelInput(readPanel(null), input({ mode: 'pin' }))).toThrow('Set a PIN');
  });

  it('stores a salted hash that verifies, never the PIN', () => {
    const p = applyPanelInput(readPanel(null), input({ mode: 'pin', pin: '4821' }));
    expect(JSON.stringify(p)).not.toContain('4821');
    expect(verifyPin('4821', p.access.pinHash!)).toBe(true);
    expect(verifyPin('1234', p.access.pinHash!)).toBe(false);
  });

  it('keeps the current PIN when none is given, and replaces it when one is', () => {
    const first = applyPanelInput(readPanel(null), input({ mode: 'pin', pin: '4821' }));
    const kept = applyPanelInput(first, input({ mode: 'pin', trustedIps: ['10.0.0.5'] }));
    expect(kept.access.pinHash).toBe(first.access.pinHash);
    expect(kept.access.trustedIps).toEqual(['10.0.0.5']);
    const changed = applyPanelInput(first, input({ mode: 'pin', pin: '9999' }));
    expect(verifyPin('9999', changed.access.pinHash!)).toBe(true);
    expect(verifyPin('4821', changed.access.pinHash!)).toBe(false);
  });

  it('drops the PIN hash when going back to open', () => {
    const first = applyPanelInput(readPanel(null), input({ mode: 'pin', pin: '4821' }));
    const open = applyPanelInput(first, input({ mode: 'open' }));
    expect(open.access.pinHash).toBeUndefined();
  });
});

describe('PanelInput validation', () => {
  it('only accepts 4 to 8 digit PINs', () => {
    const ok = (pin: string) => PanelInput.safeParse(input({ mode: 'pin', pin })).success;
    expect(ok('4821')).toBe(true);
    expect(ok('12345678')).toBe(true);
    for (const bad of ['123', '123456789', 'abcd', '12 34', ''])
      expect(ok(bad), bad).toBe(false);
  });

  it('caps the number of trusted addresses', () => {
    expect(
      PanelInput.safeParse(input({ trustedIps: Array.from({ length: 51 }, (_, i) => `10.0.0.${i}`) })).success,
    ).toBe(false);
  });
});
