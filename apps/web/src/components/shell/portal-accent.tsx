'use client';
import { portalAccentCss } from '@/lib/accent';

/** Recolours the portal with the organisation's accent colour. Renders nothing without one. */
export function PortalAccent({ accent }: { accent?: string | null }) {
  const css = portalAccentCss(accent);
  return css ? <style data-portal-accent>{css}</style> : null;
}
