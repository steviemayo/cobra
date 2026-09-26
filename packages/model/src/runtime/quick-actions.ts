import { z } from 'zod';

// Quick actions are one-tap extras in the panel's bottom bar. A driver declares which of these its
// device supports; the room then offers one only if the room also has what it needs (see the engine).
// Ids are standard so the same action on several devices becomes one button acting on all of them.
export const QUICK_ACTION_IDS = ['display.blank', 'mics.privacy_mute'] as const;
export const QuickActionId = z.enum(QUICK_ACTION_IDS);
export type QuickActionId = z.infer<typeof QuickActionId>;

export interface QuickActionInfo {
  label: string;
  icon: string;
  kind: 'toggle' | 'button';
}

export const QUICK_ACTIONS: Record<QuickActionId, QuickActionInfo> = {
  'display.blank': { label: 'Blank Screen', icon: 'blank', kind: 'toggle' },
  'mics.privacy_mute': { label: 'Privacy Mute', icon: 'mic-off', kind: 'toggle' },
};
