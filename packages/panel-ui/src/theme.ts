import type { CSSProperties } from 'react';

// Per-organisation branding. Everything else is derived from these few values.
export interface PanelTheme {
  mode: 'dark' | 'light';
  /** Main brand colour: selected states, primary buttons. */
  accent: string;
  /** Text on top of the accent. */
  accentText: string;
  logoUrl?: string;
  /** Optional overrides of the mode's neutral palette. */
  background?: string;
  surface?: string;
  text?: string;
}

export const darkTheme: PanelTheme = { mode: 'dark', accent: '#4d9dff', accentText: '#04101f' };
export const lightTheme: PanelTheme = { mode: 'light', accent: '#1462cc', accentText: '#ffffff' };

/** Neutral backgrounds the accent has to stand out from. */
const BACKGROUND = { dark: '#0d1216', light: '#f4f6f8' } as const;

function channels(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two hex colours, 1 to 21. NaN if either is not a hex colour. */
export function contrastRatio(a: string, b: string): number {
  const ca = channels(a);
  const cb = channels(b);
  if (!ca || !cb) return NaN;
  const [hi, lo] = [luminance(ca), luminance(cb)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function hex(c: [number, number, number]): string {
  return '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

// Body text needs 4.5:1. Controls and large text need 3:1 (WCAG 2.1 AA).
const TEXT_CONTRAST = 4.5;
const CONTROL_CONTRAST = 3;

/**
 * Make an org's accent colour legible: it must stand out from the background (3:1), and the text on
 * it must reach 4.5:1. The accent is nudged lighter (dark mode) or darker (light mode) until it
 * passes, and the text colour is chosen (near-black or white) unless a passing one was supplied.
 */
export function legibleAccent(
  mode: 'dark' | 'light',
  accent: string,
  accentText?: string,
): { accent: string; accentText: string } {
  const bg = BACKGROUND[mode];
  let rgb = channels(accent);
  if (!rgb) {
    const base = mode === 'dark' ? darkTheme : lightTheme;
    return { accent: base.accent, accentText: base.accentText };
  }
  const towards = mode === 'dark' ? 255 : 0;
  for (let i = 0; i < 40 && contrastRatio(hex(rgb), bg) < CONTROL_CONTRAST; i++)
    rgb = rgb.map((v) => v + (towards - v) * 0.08) as [number, number, number];
  const fixed = hex(rgb);
  if (accentText && contrastRatio(accentText, fixed) >= TEXT_CONTRAST)
    return { accent: fixed, accentText };
  const dark = '#04101f';
  return {
    accent: fixed,
    accentText: contrastRatio(dark, fixed) >= contrastRatio('#ffffff', fixed) ? dark : '#ffffff',
  };
}

/** Turn a manifest's branding into a theme, filling gaps from the mode defaults. */
export function themeFromBranding(
  branding?: {
    mode: 'dark' | 'light';
    accent?: string;
    accentText?: string;
    logoUrl?: string;
  } | null,
): PanelTheme {
  const base = branding?.mode === 'light' ? lightTheme : darkTheme;
  const colours = branding?.accent
    ? legibleAccent(base.mode, branding.accent, branding.accentText)
    : { accent: base.accent, accentText: base.accentText };
  return { ...base, ...colours, ...(branding?.logoUrl ? { logoUrl: branding.logoUrl } : {}) };
}

const PALETTE = {
  dark: {
    bg: '#0d1216',
    surface: '#161d23',
    raised: '#1e272f',
    text: '#eef2f5',
    muted: '#9aa8b3',
    line: '#ffffff1f',
  },
  light: {
    bg: '#f4f6f8',
    surface: '#ffffff',
    raised: '#eef1f4',
    text: '#141b21',
    muted: '#5b6a76',
    line: '#0000001f',
  },
};

export function themeStyle(theme: PanelTheme): CSSProperties {
  const p = PALETTE[theme.mode];
  return {
    '--kp-bg': theme.background ?? p.bg,
    '--kp-surface': theme.surface ?? p.surface,
    '--kp-raised': p.raised,
    '--kp-text': theme.text ?? p.text,
    '--kp-muted': p.muted,
    '--kp-line': p.line,
    '--kp-accent': theme.accent,
    '--kp-accent-text': theme.accentText,
    '--kp-ok': theme.mode === 'dark' ? '#4fd39a' : '#118a5b',
    '--kp-warn': theme.mode === 'dark' ? '#f2bc4b' : '#a86b00',
    '--kp-error': theme.mode === 'dark' ? '#ff7a70' : '#c2332a',
  } as CSSProperties;
}
