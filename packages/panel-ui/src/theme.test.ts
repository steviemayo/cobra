import { describe, expect, it } from 'vitest';
import { contrastRatio, darkTheme, legibleAccent, lightTheme, themeFromBranding } from './theme';

describe('contrast', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
    expect(Number.isNaN(contrastRatio('red', '#fff'))).toBe(true);
  });

  it('the default accents are legible on their backgrounds', () => {
    expect(contrastRatio(darkTheme.accent, '#0d1216')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(darkTheme.accentText, darkTheme.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(lightTheme.accent, '#f4f6f8')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(lightTheme.accentText, lightTheme.accent)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('an organisation accent colour', () => {
  it('is lightened until it stands out from a dark background', () => {
    const { accent, accentText } = legibleAccent('dark', '#1a237e');
    expect(contrastRatio(accent, '#0d1216')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(accentText, accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('is darkened until it stands out from a light background', () => {
    const { accent, accentText } = legibleAccent('light', '#ffee88');
    expect(contrastRatio(accent, '#f4f6f8')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(accentText, accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps a good colour and a good text colour as given', () => {
    expect(legibleAccent('dark', '#3ddc97', '#000000')).toEqual({
      accent: '#3ddc97',
      accentText: '#000000',
    });
  });

  it('replaces text that would be unreadable on the accent', () => {
    const { accentText } = legibleAccent('dark', '#3ddc97', '#88ffaa');
    expect(accentText).not.toBe('#88ffaa');
  });

  it('falls back to the defaults for something that is not a colour', () => {
    expect(legibleAccent('dark', 'rebeccapurple')).toEqual({
      accent: darkTheme.accent,
      accentText: darkTheme.accentText,
    });
  });

  it('is applied by themeFromBranding', () => {
    const t = themeFromBranding({ mode: 'dark', accent: '#1a237e' });
    expect(contrastRatio(t.accent, '#0d1216')).toBeGreaterThanOrEqual(3);
    expect(themeFromBranding(null)).toEqual(darkTheme);
  });
});
