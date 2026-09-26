import { describe, expect, it } from 'vitest';
import { contrastRatio } from '@kestrel/panel-ui';
import { accentAdjustments, isAccent, portalAccent, portalAccentCss } from './accent';

const COLOURS = [
  '#0f8a8c', // a teal
  '#ffffff', // white: unreadable on a light page until darkened
  '#000000', // black: unreadable on a dark page until lightened
  '#ffff00', // yellow
  '#ff0000',
  '#123',
  '#7f7f7f', // mid grey
  '#1a237e', // very dark blue
  '#fff59d', // pale yellow
];

describe('the portal accent', () => {
  it('always stands out from the page and keeps its text readable, whatever colour is chosen', () => {
    for (const c of COLOURS) {
      const light = portalAccent('light', c);
      const dark = portalAccent('dark', c);
      expect(contrastRatio(light.accent, '#eef1f4'), `light ${c}`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(dark.accent, '#14191f'), `dark ${c}`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(light.text, light.accent), `light text ${c}`).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(dark.text, dark.accent), `dark text ${c}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('leaves a colour that already works alone', () => {
    expect(portalAccent('light', '#0b5cad').accent).toBe('#0b5cad');
    expect(portalAccentCss('#0b5cad')).toContain('--primary:#0b5cad');
  });

  it('says when a colour had to change, and to what', () => {
    expect(accentAdjustments('#0b5cad')).toMatchObject({ changed: true }); // too dark for the dark theme
    const white = accentAdjustments('#ffffff')!;
    expect(white.changed).toBe(true);
    expect(white.light.accent).not.toBe('#ffffff');
    expect(accentAdjustments('nonsense')).toBeNull();
    expect(accentAdjustments('')).toBeNull();
  });

  it('only accepts real hex colours', () => {
    for (const ok of ['#fff', '#0f8a8c', ' #0F8A8C ']) expect(isAccent(ok), ok).toBe(true);
    for (const bad of [
      '',
      'red',
      '#12',
      '#12345',
      '#0f8a8c00',
      'url(x)',
      '#fff;}body{display:none',
      null,
      undefined,
    ])
      expect(isAccent(bad as string), String(bad)).toBe(false);
  });

  it('writes CSS for both themes from computed colours only', () => {
    const css = portalAccentCss('#0f8a8c')!;
    expect(css).toMatch(/^:root\{[^}]+\}\.dark\{[^}]+\}$/);
    for (const token of [
      '--primary',
      '--primary-foreground',
      '--ring',
      '--sidebar-primary',
      '--sidebar-primary-foreground',
    ])
      expect(css.match(new RegExp(`${token}:`, 'g'))).toHaveLength(2);
    // Nothing typed by a person can reach the stylesheet.
    expect(css).toMatch(/^[:.\w{}\-#;,]+$/);
  });

  it('adds nothing without a valid accent, and refuses an injection attempt', () => {
    expect(portalAccentCss(null)).toBeNull();
    expect(portalAccentCss(undefined)).toBeNull();
    expect(portalAccentCss('')).toBeNull();
    expect(portalAccentCss('#fff;}body{display:none')).toBeNull();
    expect(portalAccentCss('red')).toBeNull();
  });
});
