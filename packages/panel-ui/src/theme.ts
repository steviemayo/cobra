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

export const darkTheme: PanelTheme = { mode: 'dark', accent: '#3db8b8', accentText: '#04181a' };
export const lightTheme: PanelTheme = { mode: 'light', accent: '#0f8a8c', accentText: '#ffffff' };

/** Turn a manifest's branding into a theme, filling gaps from the mode defaults. */
export function themeFromBranding(
  branding?: { mode: 'dark' | 'light'; accent?: string; accentText?: string; logoUrl?: string } | null,
): PanelTheme {
  const base = branding?.mode === 'light' ? lightTheme : darkTheme;
  return {
    ...base,
    ...(branding?.accent ? { accent: branding.accent } : {}),
    ...(branding?.accentText ? { accentText: branding.accentText } : {}),
    ...(branding?.logoUrl ? { logoUrl: branding.logoUrl } : {}),
  };
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
