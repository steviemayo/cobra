import { contrastRatio, legibleAccent } from '@kestrel/panel-ui';

// An organisation's accent colour also themes its portal, with the same contrast rule as its room
// panels: whatever colour is chosen, it is lightened (dark theme) or darkened (light theme) until it
// stands out from the page, and the text on it is chosen to stay readable. The colour that reaches
// the page is always one computed here, never the text someone typed.
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const CONTROL_CONTRAST = 3;
/** The palest surface in the light theme and the lightest in the dark theme: the hardest to stand out from. */
const WORST_SURFACE = { light: '#eef1f4', dark: '#14191f' } as const;

type Mode = 'light' | 'dark';

const expand = (hex: string) =>
  hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;

const channels = (hex: string): [number, number, number] => {
  const h = expand(hex).slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const toHex = (rgb: number[]) =>
  '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

export const isAccent = (value: string | null | undefined): value is string =>
  !!value && HEX.test(value.trim());

/** The accent and text colours to use in one theme. */
export function portalAccent(mode: Mode, accent: string): { accent: string; text: string } {
  let a = legibleAccent(mode, expand(accent.trim())).accent;
  // The portal's surfaces are a little lighter than a panel's dark background, so nudge further if needed.
  const towards = mode === 'dark' ? 255 : 0;
  for (let i = 0; i < 20 && contrastRatio(a, WORST_SURFACE[mode]) < CONTROL_CONTRAST; i++)
    a = toHex(channels(a).map((v) => v + (towards - v) * 0.08));
  // Pick the text for the final colour.
  const text = contrastRatio('#04101f', a) >= contrastRatio('#ffffff', a) ? '#04101f' : '#ffffff';
  return { accent: a, text };
}

/** Whether a chosen colour had to change to stay readable, and what it became in each theme. */
export function accentAdjustments(accent: string) {
  if (!isAccent(accent)) return null;
  const wanted = expand(accent.trim()).toLowerCase();
  const light = portalAccent('light', accent);
  const dark = portalAccent('dark', accent);
  return { light, dark, changed: light.accent !== wanted || dark.accent !== wanted };
}

/**
 * CSS that recolours the portal's primary controls, focus ring and sidebar highlight for both
 * themes. Returns null when there is no (valid) accent, so the portal keeps its normal look.
 */
export function portalAccentCss(accent: string | null | undefined): string | null {
  if (!isAccent(accent)) return null;
  const block = (mode: Mode) => {
    const c = portalAccent(mode, accent);
    return [
      `--primary:${c.accent}`,
      `--primary-foreground:${c.text}`,
      `--ring:${c.accent}`,
      `--sidebar-primary:${c.accent}`,
      `--sidebar-primary-foreground:${c.text}`,
    ].join(';');
  };
  return `:root{${block('light')}}.dark{${block('dark')}}`;
}
