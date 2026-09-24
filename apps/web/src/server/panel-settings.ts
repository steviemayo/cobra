import { hashPin } from '@kestrel/crypto';
import { PanelAccess, PanelBranding } from '@kestrel/model';
import { z } from 'zod';

// Per-room panel settings, stored on Room.panel and copied into every release's manifest.
export const StoredPanel = z.object({
  access: PanelAccess.default(() => PanelAccess.parse({})),
  branding: PanelBranding.default(() => PanelBranding.parse({})),
});
export type StoredPanel = z.infer<typeof StoredPanel>;

export const readPanel = (raw: unknown): StoredPanel => {
  const parsed = StoredPanel.safeParse(raw ?? {});
  return parsed.success ? parsed.data : StoredPanel.parse({});
};

/** What the portal may see: never the PIN hash. */
export function publicPanel(p: StoredPanel) {
  return {
    mode: p.access.mode,
    hasPin: !!p.access.pinHash,
    trustedIps: p.access.trustedIps,
    branding: p.branding,
  };
}

export const PanelInput = z.object({
  mode: z.enum(['open', 'pin']),
  /** New PIN (4-8 digits). Omit to keep the current one. */
  pin: z
    .string()
    .regex(/^\d{4,8}$/, 'PIN must be 4 to 8 digits')
    .optional(),
  trustedIps: z.array(z.string().trim().min(2).max(45)).max(50).default([]),
  branding: PanelBranding,
});
export type PanelInput = z.infer<typeof PanelInput>;

/** Merge a settings change into what is stored. A PIN is required to switch PIN mode on. */
export function applyPanelInput(current: StoredPanel, input: PanelInput): StoredPanel {
  const pinHash = input.pin ? hashPin(input.pin) : current.access.pinHash;
  if (input.mode === 'pin' && !pinHash) throw new Error('Set a PIN to require one');
  return {
    access: { mode: input.mode, pinHash: input.mode === 'pin' ? pinHash : undefined, trustedIps: input.trustedIps },
    branding: input.branding,
  };
}
