import { hashPin } from '@kestrel/crypto';
import { PanelAccess, PanelBranding } from '@kestrel/model';
import { z } from 'zod';

// Per-room panel settings, stored on Room.panel and copied into every release's manifest.
export const StoredPanel = z.object({
  access: PanelAccess.default(() => PanelAccess.parse({})),
  branding: PanelBranding.default(() => PanelBranding.parse({})),
  /** Use the organisation's theme instead of this room's own. Rooms saved before this existed keep theirs. */
  inheritBranding: z.boolean().default(false),
});
export type StoredPanel = z.infer<typeof StoredPanel>;

export const readPanel = (raw: unknown): StoredPanel => {
  // A room nobody has customised follows the organisation's theme.
  if (raw === null || raw === undefined) return StoredPanel.parse({ inheritBranding: true });
  const parsed = StoredPanel.safeParse(raw);
  return parsed.success ? parsed.data : StoredPanel.parse({ inheritBranding: true });
};

/** The organisation's default look for panels. Anything unset falls back to the built-in theme. */
export const OrgBranding = PanelBranding;
export const readOrgBranding = (raw: unknown): PanelBranding => {
  const parsed = PanelBranding.safeParse(raw ?? {});
  return parsed.success ? parsed.data : PanelBranding.parse({});
};

/** What goes into a release: the room's panel, wearing the organisation's theme if it follows it. */
export function effectivePanel(panel: StoredPanel, org: PanelBranding) {
  const { inheritBranding, ...rest } = panel;
  return inheritBranding ? { ...rest, branding: org } : rest;
}

/** What the portal may see: never the PIN hash. */
export function publicPanel(p: StoredPanel) {
  return {
    mode: p.access.mode,
    hasPin: !!p.access.pinHash,
    trustedIps: p.access.trustedIps,
    branding: p.branding,
    inheritBranding: p.inheritBranding,
  };
}

export const PanelInput = z.object({
  mode: z.enum(['open', 'pin']),
  /**
   * New PIN (6-8 digits; a room already using a shorter one keeps it until it is changed). Omit to
   * keep the current one.
   */
  pin: z
    .string()
    .regex(/^\d{6,8}$/, 'PIN must be 6 to 8 digits')
    .optional(),
  trustedIps: z.array(z.string().trim().min(2).max(45)).max(50).default([]),
  branding: PanelBranding,
  inheritBranding: z.boolean().default(false),
});
export type PanelInput = z.infer<typeof PanelInput>;

/** Merge a settings change into what is stored. A PIN is required to switch PIN mode on. */
export function applyPanelInput(current: StoredPanel, input: PanelInput): StoredPanel {
  const pinHash = input.pin ? hashPin(input.pin) : current.access.pinHash;
  if (input.mode === 'pin' && !pinHash) throw new Error('Set a PIN to require one');
  return {
    access: {
      mode: input.mode,
      pinHash: input.mode === 'pin' ? pinHash : undefined,
      trustedIps: input.trustedIps,
    },
    branding: input.branding,
    inheritBranding: input.inheritBranding,
  };
}
